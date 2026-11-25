// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ISettlementOracle} from "./ISettlementOracle.sol";
import {PullOracleConsumerBase} from "./atlas/base/PullOracleConsumerBase.sol";
import {PullOracleReferenceHooks} from "./atlas/libraries/PullOracleReferenceHooks.sol";

/**
 * @title AtlasPullSettlementOracle
 * @notice Permissionless cryptographic settlement oracle implementing ISettlementOracle
 *         on top of Atlas Oracle's PullOracleConsumerBase.
 *
 *         Callers attach signed Atlas Pull extraData ([Packages][Count][Sig][0x7096])
 *         as trailing calldata when invoking `settleWithAtlasProof` or `verifyLatestAtlasPrice`:
 *         - `settleWithAtlasProof(assetId, expiry)` verifies the ECDSA signature from
 *           `authorizedSigner`, pins the signed Atlas `aggregatedTimestamp` tightly to
 *           `[expiry - maxPreExpiryLag, expiry + maxPostExpirySlack]` (supporting
 *           historical `/v1/price/history` signed proofs even hours after expiry),
 *           converts the 18-decimal Atlas price into the vault's 8-decimal `uint64` format,
 *           and permanently records the settlement.
 *         - `verifyLatestAtlasPrice(assetId)` verifies a live Atlas payload via `eth_call`,
 *           enforcing `block.timestamp <= aggregatedTimestamp + maxLiveFreshness`.
 *         - Owner retains emergency `setSettlementPaused(bool)` circuit breaker and
 *           governance controls for signer rotation, feed registration, and window tuning.
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
    uint256 internal constant PRICE_SCALE_DIVISOR = 1e10; // 18-dec Atlas -> 8-dec Vault

    struct AtlasProofMeta {
        bytes4 feedId;
        uint64 oracleTimestamp;
        address submitter;
    }

    address public authorizedSigner;
    bool public settlementPaused;

    uint64 public maxPreExpiryLag;
    uint64 public maxPostExpirySlack;
    uint64 public maxLiveFreshness;

    mapping(bytes32 => bytes4) public assetFeedIds;
    mapping(bytes32 => SettlementData) public settlements;
    mapping(bytes32 => AtlasProofMeta) public settlementMeta;

    event AuthorizedSignerUpdated(address indexed newSigner);
    event AssetFeedIdUpdated(bytes32 indexed assetId, bytes4 feedId);
    event SettlementWindowsUpdated(
        uint64 maxPreExpiryLag,
        uint64 maxPostExpirySlack,
        uint64 maxLiveFreshness
    );
    event SettlementPausedUpdated(bool paused);
    event ExpirySettled(
        bytes32 indexed assetId,
        uint64 indexed expiry,
        uint64 settlementPrice,
        address indexed submitter,
        bytes4 feedId,
        uint64 oracleTimestamp
    );

    error ZeroAddress();
    error InvalidAsset();
    error InvalidExpiry();
    error InvalidFeedId();
    error InvalidPrice();
    error InvalidWindow();
    error FeedNotConfigured();
    error ExpiryNotReached();
    error AlreadySettled();
    error SettlementPaused();
    error TimestampOutsideExpiryWindow(uint256 oracleTimestamp, uint64 expiry);
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
        assetFeedIds[ASSET_BTC] = FEED_BTC;
        assetFeedIds[ASSET_ETH] = FEED_ETH;

        maxPreExpiryLag = 60;
        maxPostExpirySlack = 60;
        maxLiveFreshness = 180;

        emit AuthorizedSignerUpdated(initialAuthorizedSigner);
        emit AssetFeedIdUpdated(ASSET_BTC, FEED_BTC);
        emit AssetFeedIdUpdated(ASSET_ETH, FEED_ETH);
        emit SettlementWindowsUpdated(60, 60, 180);
    }

    // =========================================================================
    // Core Permissionless Settlement & On-Chain Live Proof Verification
    // =========================================================================

    function settlementKey(
        bytes32 assetId,
        uint64 expiry
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(assetId, expiry));
    }

    /**
     * @notice Permissionlessly settle an expired `(assetId, expiry)` using a signed
     *         Atlas Pull Oracle payload appended as trailing calldata extraData.
     * @param assetId Asset identifier (e.g. `keccak256("BTC")`, `keccak256("ETH")`).
     * @param expiry Unix timestamp (seconds) of the expiry to settle.
     * @return settlementPrice Final 8-decimal USD settlement price stored on-chain.
     */
    function settleWithAtlasProof(
        bytes32 assetId,
        uint64 expiry
    ) external returns (uint64 settlementPrice) {
        if (settlementPaused) revert SettlementPaused();
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (expiry == 0) revert InvalidExpiry();
        if (block.timestamp < expiry) revert ExpiryNotReached();

        bytes4 feedId = assetFeedIds[assetId];
        if (feedId == bytes4(0)) revert FeedNotConfigured();

        bytes32 key = settlementKey(assetId, expiry);
        if (settlements[key].settled) revert AlreadySettled();

        // Cryptographically recovers Atlas signer from trailing calldata extraData
        // and extracts (price18, aggregatedTimestamp) for feedId
        (uint256 price18, uint256 aggregatedTs) = _getVerifiedFeedData(feedId);

        // Pin signed timestamp strictly around expiry (supports /v1/price/history proofs)
        if (
            aggregatedTs + uint256(maxPreExpiryLag) < uint256(expiry) ||
            aggregatedTs > uint256(expiry) + uint256(maxPostExpirySlack)
        ) {
            revert TimestampOutsideExpiryWindow(aggregatedTs, expiry);
        }

        uint256 scaled = price18 / PRICE_SCALE_DIVISOR;
        if (scaled == 0 || scaled > type(uint64).max) revert InvalidPrice();
        settlementPrice = uint64(scaled);

        settlements[key] = SettlementData({
            price: settlementPrice,
            settledAt: uint64(block.timestamp),
            settled: true
        });
        settlementMeta[key] = AtlasProofMeta({
            feedId: feedId,
            oracleTimestamp: uint64(aggregatedTs),
            submitter: msg.sender
        });

        emit ExpirySettled(
            assetId,
            expiry,
            settlementPrice,
            msg.sender,
            feedId,
            uint64(aggregatedTs)
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

    function getSettlementMeta(
        bytes32 assetId,
        uint64 expiry
    )
        external
        view
        returns (bytes4 feedId, uint64 oracleTimestamp, address submitter)
    {
        AtlasProofMeta memory meta = settlementMeta[settlementKey(assetId, expiry)];
        return (meta.feedId, meta.oracleTimestamp, meta.submitter);
    }

    // =========================================================================
    // Governance & Emergency Circuit Breaker Controls (Ownable2Step)
    // =========================================================================

    function setAuthorizedSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        authorizedSigner = newSigner;
        emit AuthorizedSignerUpdated(newSigner);
    }

    function setAssetFeedId(bytes32 assetId, bytes4 feedId) external onlyOwner {
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (feedId == bytes4(0)) revert InvalidFeedId();
        assetFeedIds[assetId] = feedId;
        emit AssetFeedIdUpdated(assetId, feedId);
    }

    function setSettlementWindows(
        uint64 newMaxPreExpiryLag,
        uint64 newMaxPostExpirySlack,
        uint64 newMaxLiveFreshness
    ) external onlyOwner {
        if (
            newMaxPreExpiryLag > MAX_WINDOW_LIMIT ||
            newMaxPostExpirySlack > MAX_WINDOW_LIMIT ||
            newMaxLiveFreshness == 0 ||
            newMaxLiveFreshness > MAX_WINDOW_LIMIT
        ) {
            revert InvalidWindow();
        }
        maxPreExpiryLag = newMaxPreExpiryLag;
        maxPostExpirySlack = newMaxPostExpirySlack;
        maxLiveFreshness = newMaxLiveFreshness;
        emit SettlementWindowsUpdated(
            newMaxPreExpiryLag,
            newMaxPostExpirySlack,
            newMaxLiveFreshness
        );
    }

    function setSettlementPaused(bool paused) external onlyOwner {
        settlementPaused = paused;
        emit SettlementPausedUpdated(paused);
    }

    // =========================================================================
    // PullOracleConsumerBase Hook Overrides
    // =========================================================================

    /**
     * @dev Rejects zero or future-drifted timestamps while delegating historical
     *      expiry window checks to `settleWithAtlasProof` and live freshness checks
     *      to `verifyLatestAtlasPrice`. This enables deterministic historical
     *      `/v1/price/history` proofs even hours after expiry.
     */
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
