// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISettlementOracle} from "./ISettlementOracle.sol";
import {PullOracleConsumerBase} from "./atlas/base/PullOracleConsumerBase.sol";
import {PullOracleReferenceHooks} from "./atlas/libraries/PullOracleReferenceHooks.sol";

/**
 * @title AtlasPullSettlementOracle
 * @notice Permissionless cryptographic 30-minute TWAP settlement oracle implementing
 *         ISettlementOracle on top of Atlas Oracle's unmodified PullOracleConsumerBase.
 *
 *         Key properties:
 *         - Deterministic 30-point equal-weighted arithmetic TWAP aligned with Deribit /
 *           OKX / Binance options settlement (`expiry - 29m` through `expiry`, 1 sample/min).
 *         - Exact-second pinning (`0s` tolerance) during the first 15 minutes after expiry,
 *           automatically relaxing to `±10s` per point afterward for liveness.
 *         - Short `settlementDelay` (default 60s) before permissionless settlement opens,
 *           giving the off-chain health sentinel (`pauser`) a clean race-free window to
 *           freeze disputed expiries (30m avg ConsensusScore < 0.40).
 *         - Role-separated dispute resolution: `pauser` may ONLY freeze (`pauseExpiry`),
 *           while `owner` may unfreeze (`unpauseExpiry`) or execute guarded
 *           `emergencyManualSettle` with an explicit public audit reason.
 */
contract AtlasPullSettlementOracle is
    ISettlementOracle,
    PullOracleConsumerBase,
    Ownable2Step
{
    bytes32 public constant ASSET_BTC = keccak256("BTC");
    bytes32 public constant ASSET_ETH = keccak256("ETH");

    bytes4 public constant FEED_BTC = 0x00000272; // Atlas feed #626 (BTC/USD)
    bytes4 public constant FEED_ETH = 0x00000278; // Atlas feed #632 (ETH/USD)

    uint64 public constant MAX_FUTURE_DRIFT = 60;
    uint64 public constant MAX_WINDOW_LIMIT = 3600;
    uint16 public constant MAX_TWAP_SAMPLE_COUNT = 60;
    uint64 public constant MAX_TWAP_WINDOW_SPAN = 30 minutes;
    uint64 public constant MAX_SETTLEMENT_DELAY = 15 minutes;
    uint256 public constant MAX_OVERRIDE_REASON_BYTES = 256;
    uint256 internal constant MIN_PROOF_BYTES = 88; // 20B pkg + 1B count + 65B sig + 2B 0x7096
    uint256 internal constant PRICE_SCALE_DIVISOR = 1e10; // 18-dec Atlas -> 8-dec Vault

    struct AtlasProofMeta {
        address submitter;
        bytes4 feedId;
        uint64 windowStartTimestamp;
        uint64 windowEndTimestamp;
        uint16 sampleCount;
        bool isManualOverride;
        string overrideReason;
    }

    address public authorizedSigner;
    address public pauser;
    bool public settlementPaused;

    uint16 public twapSampleCount;
    uint64 public twapSampleInterval;
    uint64 public settlementDelay;
    uint64 public exactMatchGracePeriod;
    uint64 public fallbackTimestampTolerance;
    uint64 public maxLiveFreshness;

    mapping(bytes32 => bytes4) public assetFeedIds;
    mapping(bytes32 => bool) public expiryPaused;
    mapping(bytes32 => SettlementData) public settlements;
    mapping(bytes32 => AtlasProofMeta) public settlementMeta;

    event AuthorizedSignerUpdated(address indexed newSigner);
    event PauserUpdated(address indexed newPauser);
    event AssetFeedIdUpdated(bytes32 indexed assetId, bytes4 feedId);
    event TwapConfigUpdated(
        uint16 sampleCount,
        uint64 sampleInterval,
        uint64 settlementDelay,
        uint64 exactMatchGracePeriod,
        uint64 fallbackTimestampTolerance
    );
    event LiveFreshnessUpdated(uint64 maxLiveFreshness);
    event SettlementPausedUpdated(bool paused);
    event ExpirySettlementPausedUpdated(
        bytes32 indexed assetId,
        uint64 indexed expiry,
        bool paused,
        address indexed caller
    );
    event ExpirySettled(
        bytes32 indexed assetId,
        uint64 indexed expiry,
        uint64 settlementPrice,
        address indexed submitter,
        bytes4 feedId,
        uint64 windowStartTimestamp,
        uint64 windowEndTimestamp,
        uint16 sampleCount
    );
    event EmergencyExpirySettled(
        bytes32 indexed assetId,
        uint64 indexed expiry,
        uint64 settlementPrice,
        address indexed admin,
        string reason
    );

    error ZeroAddress();
    error Unauthorized();
    error InvalidAsset();
    error InvalidExpiry();
    error InvalidFeedId();
    error InvalidPrice();
    error InvalidWindow();
    error InvalidTwapConfig();
    error InvalidProofCount(uint256 provided, uint256 expected);
    error InvalidProofLength(uint256 index, uint256 length);
    error InvalidReason();
    error FeedNotConfigured();
    error ExpiryNotReached();
    error SettlementDelayNotElapsed(uint256 availableAt, uint256 currentTimestamp);
    error AlreadySettled();
    error SettlementPaused();
    error ExpirySettlementPaused();
    error ExpiryNotPaused();
    error SampleTimestampMismatch(
        uint256 index,
        uint256 oracleTimestamp,
        uint256 targetTimestamp,
        uint256 tolerance
    );
    error StaleAtlasPrice(uint256 oracleTimestamp, uint256 currentTimestamp);
    error InvalidOracleTimestamp(
        bytes4 feedId,
        uint256 parsedTimestamp,
        uint256 currentTimestamp
    );

    constructor(
        address initialOwner,
        address initialAuthorizedSigner
    ) Ownable(initialOwner) {
        if (initialAuthorizedSigner == address(0)) revert ZeroAddress();

        authorizedSigner = initialAuthorizedSigner;
        pauser = initialOwner;
        assetFeedIds[ASSET_BTC] = FEED_BTC;
        assetFeedIds[ASSET_ETH] = FEED_ETH;

        twapSampleCount = 30;
        twapSampleInterval = 60;
        settlementDelay = 60;
        exactMatchGracePeriod = 900;
        fallbackTimestampTolerance = 10;
        maxLiveFreshness = 180;

        emit AuthorizedSignerUpdated(initialAuthorizedSigner);
        emit PauserUpdated(initialOwner);
        emit AssetFeedIdUpdated(ASSET_BTC, FEED_BTC);
        emit AssetFeedIdUpdated(ASSET_ETH, FEED_ETH);
        emit TwapConfigUpdated(30, 60, 60, 900, 10);
        emit LiveFreshnessUpdated(180);
    }

    // =========================================================================
    // Core Permissionless 30-Minute TWAP Settlement & Live Proof Verification
    // =========================================================================

    function settlementKey(
        bytes32 assetId,
        uint64 expiry
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(assetId, expiry));
    }

    /**
     * @notice Read-only helper that verifies a single Atlas Pull proof appended as
     *         trailing calldata using unmodified `PullOracleConsumerBase._getVerifiedFeedData`.
     */
    function verifyAtlasFeedProof(
        bytes4 feedId
    ) external view returns (uint256 price18, uint256 aggregatedTimestamp) {
        if (feedId == bytes4(0)) revert InvalidFeedId();
        return _getVerifiedFeedData(feedId);
    }

    /**
     * @notice Returns the deterministic sampling schedule for a given `expiry`.
     *         For default (30, 60s), returns `[expiry - 29m, expiry - 28m, ..., expiry]`.
     */
    function getTwapSampleTimestamps(
        uint64 expiry
    ) external view returns (uint64[] memory timestamps) {
        uint16 count = twapSampleCount;
        uint64 interval = twapSampleInterval;
        uint256 span = uint256(count - 1) * uint256(interval);
        if (expiry == 0 || uint256(expiry) <= span) revert InvalidExpiry();

        timestamps = new uint64[](count);
        for (uint256 i = 0; i < count; ) {
            timestamps[i] = uint64(
                uint256(expiry) - uint256(count - 1 - i) * uint256(interval)
            );
            unchecked {
                ++i;
            }
        }
    }

    /**
     * @notice Permissionlessly settles `(assetId, expiry)` using `twapSampleCount`
     *         chronologically ordered signed Atlas Pull extraData proofs.
     *         Computed once per `(assetId, expiry)` and reused by all vault redemptions.
     * @param assetId Asset identifier (e.g. `keccak256("BTC")`, `keccak256("ETH")`).
     * @param expiry Unix timestamp (seconds) of the expiry to settle.
     * @param proofs Array of signed Atlas extraData bytes `[Packages][Count][Sig][0x7096]`.
     * @return settlementPrice Final 8-decimal USD TWAP settlement price stored on-chain.
     */
    function settleWithAtlasTwap(
        bytes32 assetId,
        uint64 expiry,
        bytes[] calldata proofs
    ) external returns (uint64 settlementPrice) {
        if (settlementPaused) revert SettlementPaused();
        if (assetId == bytes32(0)) revert InvalidAsset();

        uint16 count = twapSampleCount;
        uint64 interval = twapSampleInterval;
        uint256 span = uint256(count - 1) * uint256(interval);
        if (expiry == 0 || uint256(expiry) <= span) revert InvalidExpiry();
        if (block.timestamp < expiry) revert ExpiryNotReached();

        uint256 availableAt = uint256(expiry) + uint256(settlementDelay);
        if (block.timestamp < availableAt) {
            revert SettlementDelayNotElapsed(availableAt, block.timestamp);
        }

        bytes4 feedId = assetFeedIds[assetId];
        if (feedId == bytes4(0)) revert FeedNotConfigured();

        bytes32 key = settlementKey(assetId, expiry);
        if (expiryPaused[key]) revert ExpirySettlementPaused();
        if (settlements[key].settled) revert AlreadySettled();
        if (proofs.length != count) revert InvalidProofCount(proofs.length, count);

        uint256 tolerance = block.timestamp <=
            uint256(expiry) + uint256(exactMatchGracePeriod)
            ? 0
            : uint256(fallbackTimestampTolerance);

        uint256 sumPrice18;
        uint64 firstTs;
        uint64 lastTs;
        bytes memory encodedFeedId = abi.encode(feedId);
        bytes4 verifySelector = this.verifyAtlasFeedProof.selector;

        for (uint256 i = 0; i < count; ) {
            bytes calldata proof = proofs[i];
            if (proof.length < MIN_PROOF_BYTES) {
                revert InvalidProofLength(i, proof.length);
            }

            (bool ok, bytes memory ret) = address(this).staticcall(
                abi.encodePacked(verifySelector, encodedFeedId, proof)
            );
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }

            (uint256 price18, uint256 aggregatedTs) = abi.decode(
                ret,
                (uint256, uint256)
            );
            if (price18 == 0) revert InvalidPrice();

            uint256 targetTs = uint256(expiry) -
                uint256(count - 1 - i) * uint256(interval);
            uint256 diff = aggregatedTs >= targetTs
                ? aggregatedTs - targetTs
                : targetTs - aggregatedTs;
            if (diff > tolerance) {
                revert SampleTimestampMismatch(i, aggregatedTs, targetTs, tolerance);
            }

            if (i == 0) {
                firstTs = uint64(aggregatedTs);
            }
            lastTs = uint64(aggregatedTs);
            sumPrice18 += price18;

            unchecked {
                ++i;
            }
        }

        uint256 scaled = sumPrice18 / (uint256(count) * PRICE_SCALE_DIVISOR);
        if (scaled == 0 || scaled > type(uint64).max) revert InvalidPrice();
        settlementPrice = uint64(scaled);

        settlements[key] = SettlementData({
            price: settlementPrice,
            settledAt: uint64(block.timestamp),
            settled: true
        });
        settlementMeta[key] = AtlasProofMeta({
            submitter: msg.sender,
            feedId: feedId,
            windowStartTimestamp: firstTs,
            windowEndTimestamp: lastTs,
            sampleCount: count,
            isManualOverride: false,
            overrideReason: ""
        });

        emit ExpirySettled(
            assetId,
            expiry,
            settlementPrice,
            msg.sender,
            feedId,
            firstTs,
            lastTs,
            count
        );
    }

    /**
     * @notice View helper to cryptographically verify a live Atlas signed payload
     *         via `eth_call` (or on-chain consumers) with live freshness enforcement.
     */
    function verifyLatestAtlasPrice(
        bytes32 assetId
    )
        external
        view
        returns (
            uint64 price8,
            uint256 price18,
            uint64 aggregatedTimestamp,
            bytes4 feedId
        )
    {
        if (assetId == bytes32(0)) revert InvalidAsset();
        feedId = assetFeedIds[assetId];
        if (feedId == bytes4(0)) revert FeedNotConfigured();

        uint256 aggregatedTs;
        (price18, aggregatedTs) = _getVerifiedFeedData(feedId);

        if (block.timestamp > aggregatedTs + uint256(maxLiveFreshness)) {
            revert StaleAtlasPrice(aggregatedTs, block.timestamp);
        }

        uint256 scaled = price18 / PRICE_SCALE_DIVISOR;
        if (scaled == 0 || scaled > type(uint64).max) revert InvalidPrice();

        price8 = uint64(scaled);
        aggregatedTimestamp = uint64(aggregatedTs);
    }

    // =========================================================================
    // Dispute Freeze & Guarded Emergency Admin Settlement
    // =========================================================================

    /**
     * @notice Freeze automated TWAP settlement for a disputed `(assetId, expiry)`.
     *         Callable by `pauser` sentinel or `owner` (including before `expiry` to
     *         prevent front-running when 30m average ConsensusScore < 0.40).
     */
    function pauseExpiry(bytes32 assetId, uint64 expiry) external {
        if (msg.sender != pauser && msg.sender != owner()) revert Unauthorized();
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (expiry == 0) revert InvalidExpiry();

        bytes32 key = settlementKey(assetId, expiry);
        if (settlements[key].settled) revert AlreadySettled();

        expiryPaused[key] = true;
        emit ExpirySettlementPausedUpdated(assetId, expiry, true, msg.sender);
    }

    /**
     * @notice Unfreeze a disputed `(assetId, expiry)` so permissionless TWAP settlement
     *         can proceed. Restricted strictly to `owner` (pauser cannot unpause).
     */
    function unpauseExpiry(bytes32 assetId, uint64 expiry) external onlyOwner {
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (expiry == 0) revert InvalidExpiry();

        bytes32 key = settlementKey(assetId, expiry);
        if (settlements[key].settled) revert AlreadySettled();

        expiryPaused[key] = false;
        emit ExpirySettlementPausedUpdated(assetId, expiry, false, msg.sender);
    }

    /**
     * @notice Guarded emergency manual settlement for a paused disputed expiry.
     *         Requires: `onlyOwner`, `block.timestamp >= expiry`, `!settled`,
     *         `expiryPaused[key] == true`, non-zero price, and non-empty audit reason.
     */
    function emergencyManualSettle(
        bytes32 assetId,
        uint64 expiry,
        uint64 settlementPrice,
        string calldata reason
    ) external onlyOwner returns (uint64) {
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (expiry == 0) revert InvalidExpiry();
        if (block.timestamp < expiry) revert ExpiryNotReached();
        if (settlementPrice == 0) revert InvalidPrice();

        uint256 reasonLen = bytes(reason).length;
        if (reasonLen == 0 || reasonLen > MAX_OVERRIDE_REASON_BYTES) {
            revert InvalidReason();
        }

        bytes32 key = settlementKey(assetId, expiry);
        if (settlements[key].settled) revert AlreadySettled();
        if (!expiryPaused[key]) revert ExpiryNotPaused();

        settlements[key] = SettlementData({
            price: settlementPrice,
            settledAt: uint64(block.timestamp),
            settled: true
        });
        settlementMeta[key] = AtlasProofMeta({
            submitter: msg.sender,
            feedId: bytes4(0),
            windowStartTimestamp: 0,
            windowEndTimestamp: 0,
            sampleCount: 0,
            isManualOverride: true,
            overrideReason: reason
        });
        expiryPaused[key] = false;

        emit EmergencyExpirySettled(
            assetId,
            expiry,
            settlementPrice,
            msg.sender,
            reason
        );
        return settlementPrice;
    }

    // =========================================================================
    // ISettlementOracle & Proof Metadata Views
    // =========================================================================

    function getSettlementPrice(
        bytes32 assetId,
        uint64 expiry
    ) external view override returns (uint64 price, bool settled) {
        SettlementData memory st = settlements[settlementKey(assetId, expiry)];
        return (st.price, st.settled);
    }

    function getSettlement(
        bytes32 assetId,
        uint64 expiry
    ) external view override returns (SettlementData memory) {
        return settlements[settlementKey(assetId, expiry)];
    }

    function isExpiryPaused(
        bytes32 assetId,
        uint64 expiry
    ) external view returns (bool) {
        return expiryPaused[settlementKey(assetId, expiry)];
    }

    function getSettlementMeta(
        bytes32 assetId,
        uint64 expiry
    )
        external
        view
        returns (
            bytes4 feedId,
            uint64 windowStartTimestamp,
            uint64 windowEndTimestamp,
            address submitter,
            uint16 sampleCount,
            bool isManualOverride,
            string memory overrideReason
        )
    {
        AtlasProofMeta memory meta = settlementMeta[settlementKey(assetId, expiry)];
        return (
            meta.feedId,
            meta.windowStartTimestamp,
            meta.windowEndTimestamp,
            meta.submitter,
            meta.sampleCount,
            meta.isManualOverride,
            meta.overrideReason
        );
    }

    // =========================================================================
    // Governance & Global Circuit Breaker Controls (Ownable2Step)
    // =========================================================================

    function setAuthorizedSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        authorizedSigner = newSigner;
        emit AuthorizedSignerUpdated(newSigner);
    }

    function setPauser(address newPauser) external onlyOwner {
        if (newPauser == address(0)) revert ZeroAddress();
        pauser = newPauser;
        emit PauserUpdated(newPauser);
    }

    function setAssetFeedId(bytes32 assetId, bytes4 feedId) external onlyOwner {
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (feedId == bytes4(0)) revert InvalidFeedId();
        assetFeedIds[assetId] = feedId;
        emit AssetFeedIdUpdated(assetId, feedId);
    }

    function setTwapConfig(
        uint16 newSampleCount,
        uint64 newSampleInterval,
        uint64 newSettlementDelay,
        uint64 newExactMatchGracePeriod,
        uint64 newFallbackTimestampTolerance
    ) external onlyOwner {
        if (
            newSampleCount == 0 ||
            newSampleCount > MAX_TWAP_SAMPLE_COUNT ||
            newSettlementDelay > MAX_SETTLEMENT_DELAY ||
            newExactMatchGracePeriod > MAX_WINDOW_LIMIT ||
            newFallbackTimestampTolerance > 60
        ) {
            revert InvalidTwapConfig();
        }
        if (newSampleCount > 1) {
            if (
                newSampleInterval == 0 ||
                uint256(newSampleCount - 1) * uint256(newSampleInterval) >
                    MAX_TWAP_WINDOW_SPAN ||
                uint256(newFallbackTimestampTolerance) * 2 >=
                    uint256(newSampleInterval)
            ) {
                revert InvalidTwapConfig();
            }
        }

        twapSampleCount = newSampleCount;
        twapSampleInterval = newSampleInterval;
        settlementDelay = newSettlementDelay;
        exactMatchGracePeriod = newExactMatchGracePeriod;
        fallbackTimestampTolerance = newFallbackTimestampTolerance;

        emit TwapConfigUpdated(
            newSampleCount,
            newSampleInterval,
            newSettlementDelay,
            newExactMatchGracePeriod,
            newFallbackTimestampTolerance
        );
    }

    function setMaxLiveFreshness(uint64 newMaxLiveFreshness) external onlyOwner {
        if (newMaxLiveFreshness == 0 || newMaxLiveFreshness > MAX_WINDOW_LIMIT) {
            revert InvalidWindow();
        }
        maxLiveFreshness = newMaxLiveFreshness;
        emit LiveFreshnessUpdated(newMaxLiveFreshness);
    }

    function setSettlementPaused(bool paused) external onlyOwner {
        settlementPaused = paused;
        emit SettlementPausedUpdated(paused);
    }

    // =========================================================================
    // PullOracleConsumerBase Hook Overrides
    // =========================================================================

    function _validateTimestamp(
        bytes4 feedId,
        uint256 parsedAggregateTimestamp
    ) internal view override {
        if (
            parsedAggregateTimestamp == 0 ||
            parsedAggregateTimestamp > block.timestamp + uint256(MAX_FUTURE_DRIFT)
        ) {
            revert InvalidOracleTimestamp(
                feedId,
                parsedAggregateTimestamp,
                block.timestamp
            );
        }
    }

    function _getMaxPackageCount() internal pure override returns (uint256) {
        return PullOracleReferenceHooks.DEFAULT_MAX_PACKAGE_COUNT;
    }

    function _isAuthorizedSigner(
        address recoveredSigner
    ) internal view override returns (bool) {
        return recoveredSigner == authorizedSigner;
    }
}
