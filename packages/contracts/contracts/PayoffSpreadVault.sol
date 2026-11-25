// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISettlementOracle} from "./ISettlementOracle.sol";

/**
 * @title PayoffSpreadVault
 * @notice Minimal, fully collateralized USDT-settled vertical spread ticket vault (Core).
 *         - Complementary UP / DOWN ERC-1155 model: 1 UP + 1 DOWN = 1 USDT locked
 *         - Zero-liquidation 100% collateralized spreads with pre-funded `makerMargin` sub-accounts
 *         - Delegated maker hot signers + EIP-1271 smart contract maker support
 *         - Maker epoch kill switch + gas-efficient 256-bit bitmap nonces + self-trade guard
 *         - On-chain controlled protocol fees with quote slippage caps & Accrue-and-Pull treasury
 *         - Decoupled ISettlementOracle & PayoffVaultLens periphery for clean separation of concerns
 */
contract PayoffSpreadVault is
    ERC1155,
    EIP712,
    Ownable2Step,
    ReentrancyGuard,
    Pausable
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    bytes32 public constant ASSET_BTC = keccak256("BTC");
    bytes32 public constant ASSET_ETH = keccak256("ETH");

    uint16 public constant MAX_OPEN_FEE_BPS = 500; // 5.00% hard protocol cap
    uint16 public constant MAX_CLOSE_FEE_BPS = 100; // 1.00% hard cap
    uint64 internal constant MIN_OPEN_LEAD_TIME = 1 hours;
    uint64 internal constant MIN_CLOSE_LEAD_TIME = 5 minutes;
    uint64 internal constant DEFAULT_SETTLEMENT_UTC_OFFSET = 8 hours;
    uint64 internal constant DEFAULT_EXPIRY_INTERVAL = 1 days;

    bytes32 internal constant OPEN_QUOTE_TYPEHASH = keccak256(
        "OpenQuote(address taker,address maker,bytes32 assetId,bool isUp,uint64 lowerStrike,uint64 upperStrike,uint64 expiry,uint256 userPayAmount,uint256 maxPayout,uint16 maxProtocolFeeBps,uint64 makerEpoch,uint64 validUntil,uint256 nonce)"
    );

    bytes32 internal constant CLOSE_QUOTE_TYPEHASH = keccak256(
        "CloseQuote(address taker,address maker,bytes32 seriesId,bool isUp,uint256 amount,uint256 buybackAmount,uint16 maxCloseFeeBps,uint64 makerEpoch,uint64 validUntil,uint256 nonce)"
    );

    struct AssetConfig {
        bool enabled;
        bool enforceStandardExpiry;
        uint64 settlementUtcOffset;
        uint64 expiryInterval;
    }

    struct Series {
        bytes32 assetId;
        uint64 lowerStrike; // 8-decimal USD price
        uint64 upperStrike; // 8-decimal USD price
        uint64 expiry; // unix seconds
        uint256 lockedUsdt;
        uint256 upSupply;
        uint256 downSupply;
    }

    struct OpenQuote {
        address taker;
        address maker;
        bytes32 assetId;
        bool isUp;
        uint64 lowerStrike;
        uint64 upperStrike;
        uint64 expiry;
        uint256 userPayAmount; // 6-decimal USDT
        uint256 maxPayout; // 6-decimal USDT
        uint16 maxProtocolFeeBps;
        uint64 makerEpoch;
        uint64 validUntil;
        uint256 nonce;
    }

    struct CloseQuote {
        address taker;
        address maker;
        bytes32 seriesId;
        bool isUp;
        uint256 amount; // 6-decimal UP or DOWN token amount to sell back
        uint256 buybackAmount; // 6-decimal gross USDT price
        uint16 maxCloseFeeBps;
        uint64 makerEpoch;
        uint64 validUntil;
        uint256 nonce;
    }

    IERC20 public immutable usdt;
    ISettlementOracle public settlementOracle;

    address public pauser;
    address public feeCollector;

    uint16 public protocolOpenFeeBps;
    uint16 public protocolCloseFeeBps;
    uint256 public accruedProtocolFees;

    mapping(bytes32 => AssetConfig) public assetConfigs;
    mapping(address => bool) public whitelistedMakers;
    mapping(address => mapping(address => bool)) public makerSigners;
    mapping(address => uint64) public makerEpoch;
    mapping(address => mapping(uint256 => uint256)) private _makerNonceBitmap;

    mapping(address => uint256) public makerMargin;
    uint256 public totalMakerMargin;

    mapping(bytes32 => Series) public seriesById;
    mapping(uint256 => bytes32) private _seriesIdByBaseToken;
    bytes32[] private _allSeriesIds;

    uint256 public totalLockedUsdt;

    mapping(address => EnumerableSet.UintSet) private _userActiveTokens;

    event PauserUpdated(address indexed newPauser);
    event FeeCollectorUpdated(address indexed newFeeCollector);
    event AssetConfigUpdated(
        bytes32 indexed assetId,
        bool enabled,
        bool enforceStandardExpiry,
        uint64 settlementUtcOffset,
        uint64 expiryInterval
    );
    event MakerWhitelistUpdated(address indexed maker, bool allowed);
    event MakerSignerUpdated(address indexed maker, address indexed signer, bool allowed);
    event MakerEpochIncremented(address indexed maker, uint64 newEpoch);
    event MakerMarginDeposited(address indexed maker, uint256 amount);
    event MakerMarginWithdrawn(address indexed maker, uint256 amount);
    event MakerMarginCredited(address indexed maker, uint256 amount);
    event ProtocolFeesUpdated(uint16 openFeeBps, uint16 closeFeeBps);
    event ProtocolFeesCollected(address indexed recipient, uint256 amount);
    event SettlementOracleUpdated(address indexed newOracle);
    event NonceCancelled(address indexed maker, uint256 indexed nonce);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    event TicketOpened(
        bytes32 indexed seriesId,
        address indexed taker,
        address indexed maker,
        bytes32 assetId,
        bool isUp,
        uint64 lowerStrike,
        uint64 upperStrike,
        uint64 expiry,
        uint256 userPayAmount,
        uint256 protocolFee,
        uint256 maxPayout,
        uint256 nonce
    );

    event TicketClosedEarly(
        bytes32 indexed seriesId,
        address indexed taker,
        address indexed maker,
        bool isUp,
        uint256 amount,
        uint256 buybackAmount,
        uint256 closeFee,
        uint256 mergedAmount,
        uint256 transferredAmount,
        uint256 nonce
    );

    event PositionMerged(
        bytes32 indexed seriesId,
        address indexed account,
        uint256 amount,
        bool creditedToMargin
    );

    event TicketRedeemed(
        bytes32 indexed seriesId,
        address indexed account,
        uint256 upBurned,
        uint256 downBurned,
        uint256 upPayoutUsdt,
        uint256 downPayoutUsdt,
        bool creditedToMargin
    );

    error ZeroAddress();
    error Unauthorized();
    error InvalidAsset();
    error AssetNotEnabled();
    error InvalidStrikes();
    error InvalidExpiry();
    error ExpiryTooSoon();
    error NotWhitelistedMaker();
    error InvalidTaker();
    error SelfTradeNotAllowed();
    error QuoteExpired();
    error InvalidMakerEpoch();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error FeeExceedsCap();
    error ProtocolFeeExceedsMax();
    error InvalidAmounts();
    error InsufficientMakerMargin();
    error InsufficientAccruedFees();
    error InsufficientSurplus();
    error SeriesDoesNotExist();
    error AlreadySettled();
    error NotSettled();
    error CloseWindowElapsed();
    error InsufficientBalance();

    constructor(
        address _usdt,
        address _settlementOracle,
        address _initialOwner,
        uint16 _protocolOpenFeeBps,
        uint16 _protocolCloseFeeBps
    )
        ERC1155("")
        EIP712("PayoffSpreadVault", "2")
        Ownable(_initialOwner)
    {
        if (_usdt == address(0) || _settlementOracle == address(0)) {
            revert ZeroAddress();
        }
        if (
            _protocolOpenFeeBps > MAX_OPEN_FEE_BPS ||
            _protocolCloseFeeBps > MAX_CLOSE_FEE_BPS
        ) {
            revert FeeExceedsCap();
        }

        usdt = IERC20(_usdt);
        settlementOracle = ISettlementOracle(_settlementOracle);
        pauser = _initialOwner;
        feeCollector = _initialOwner;
        protocolOpenFeeBps = _protocolOpenFeeBps;
        protocolCloseFeeBps = _protocolCloseFeeBps;

        _setAssetConfig(
            ASSET_BTC,
            true,
            true,
            DEFAULT_SETTLEMENT_UTC_OFFSET,
            DEFAULT_EXPIRY_INTERVAL
        );
        _setAssetConfig(
            ASSET_ETH,
            true,
            true,
            DEFAULT_SETTLEMENT_UTC_OFFSET,
            DEFAULT_EXPIRY_INTERVAL
        );

        emit PauserUpdated(_initialOwner);
        emit FeeCollectorUpdated(_initialOwner);
        emit ProtocolFeesUpdated(_protocolOpenFeeBps, _protocolCloseFeeBps);
        emit SettlementOracleUpdated(_settlementOracle);
    }

    // =========================================================================
    // Core Pure & Atomic View Helpers (consumed directly & by PayoffVaultLens)
    // =========================================================================

    function getSeriesId(
        bytes32 assetId,
        uint64 lowerStrike,
        uint64 upperStrike,
        uint64 expiry
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(assetId, lowerStrike, upperStrike, expiry));
    }

    function upTokenId(bytes32 seriesId) public pure returns (uint256) {
        return uint256(seriesId) & ~uint256(1);
    }

    function downTokenId(bytes32 seriesId) public pure returns (uint256) {
        return uint256(seriesId) | uint256(1);
    }

    function isNonceUsed(address maker, uint256 nonce) public view returns (bool) {
        uint256 wordPos = nonce >> 8;
        uint256 bitPos = nonce & 0xff;
        return (_makerNonceBitmap[maker][wordPos] & (uint256(1) << bitPos)) != 0;
    }

    function vaultHealth()
        external
        view
        returns (
            uint256 usdtBalance,
            uint256 lockedUsdt,
            uint256 makerMarginUsdt,
            uint256 protocolFeesUsdt,
            bool isSolvent
        )
    {
        usdtBalance = usdt.balanceOf(address(this));
        lockedUsdt = totalLockedUsdt;
        makerMarginUsdt = totalMakerMargin;
        protocolFeesUsdt = accruedProtocolFees;
        isSolvent = usdtBalance >= lockedUsdt + makerMarginUsdt + protocolFeesUsdt;
    }

    function previewPayout(
        bytes32 seriesId,
        uint256 upAmount,
        uint256 downAmount
    ) public view returns (uint256 upPayout, uint256 downPayout) {
        Series storage s = seriesById[seriesId];
        if (s.assetId == bytes32(0)) return (0, 0);

        (uint64 settlementPrice, bool settled) = settlementOracle.getSettlementPrice(
            s.assetId,
            s.expiry
        );
        if (!settled) return (0, 0);

        return _computePayout(s.lowerStrike, s.upperStrike, settlementPrice, upAmount, downAmount);
    }

    function getUserActiveTokenCount(address user) external view returns (uint256) {
        return _userActiveTokens[user].length();
    }

    function getUserActiveTokenAt(address user, uint256 index) external view returns (uint256) {
        return _userActiveTokens[user].at(index);
    }

    function getSeriesIdByToken(uint256 tokenId) external view returns (bytes32) {
        return _seriesIdByBaseToken[tokenId & ~uint256(1)];
    }

    function getAllSeriesCount() external view returns (uint256) {
        return _allSeriesIds.length;
    }

    function getSeriesIdAt(uint256 index) external view returns (bytes32) {
        return _allSeriesIds[index];
    }

    // =========================================================================
    // Maker Margin Sub-Account Management (100% Collateralized, Zero Liquidation)
    // =========================================================================

    function depositMakerMargin(
        uint256 amount
    ) external nonReentrant whenNotPaused {
        if (!whitelistedMakers[msg.sender]) revert NotWhitelistedMaker();
        if (amount == 0) revert InvalidAmounts();

        usdt.safeTransferFrom(msg.sender, address(this), amount);
        makerMargin[msg.sender] += amount;
        totalMakerMargin += amount;

        emit MakerMarginDeposited(msg.sender, amount);
    }

    /**
     * @notice Withdraw idle maker margin. Intentionally NOT restricted by `whenNotPaused`
     *         or active whitelist status so makers can always withdraw free collateral.
     */
    function withdrawMakerMargin(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmounts();
        if (makerMargin[msg.sender] < amount) revert InsufficientMakerMargin();

        makerMargin[msg.sender] -= amount;
        totalMakerMargin -= amount;

        usdt.safeTransfer(msg.sender, amount);
        emit MakerMarginWithdrawn(msg.sender, amount);
    }

    // =========================================================================
    // Core Trading: RFQ Open & Reverse-RFQ Close
    // =========================================================================

    function fillOpenQuote(
        OpenQuote calldata quote,
        bytes calldata makerSignature
    ) external nonReentrant whenNotPaused returns (bytes32 seriesId) {
        _validateOpenQuoteAndConsumeNonce(quote, makerSignature);
        usdt.safeTransferFrom(quote.taker, address(this), quote.userPayAmount);
        seriesId = _finalizeOpenQuote(quote);
    }

    function fillCloseQuote(
        CloseQuote calldata quote,
        bytes calldata makerSignature
    ) external nonReentrant whenNotPaused {
        _validateCloseQuoteAndConsumeNonce(quote, makerSignature);
        _executeCloseQuote(quote);
    }

    /**
     * @notice Permissionless merge: anyone holding matched UP + DOWN pairs before settlement
     *         can burn them 1:1 to unlock USDT immediately. Intentionally NOT restricted by
     *         `whenNotPaused` so positions can always unwind safely.
     *         Whitelisted makers receive proceeds into `makerMargin`; others receive direct USDT.
     */
    function merge(bytes32 seriesId, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmounts();
        Series storage s = seriesById[seriesId];
        if (s.assetId == bytes32(0)) revert SeriesDoesNotExist();
        (, bool settled) = settlementOracle.getSettlementPrice(s.assetId, s.expiry);
        if (settled) revert AlreadySettled();

        uint256 uId = upTokenId(seriesId);
        uint256 dId = downTokenId(seriesId);
        if (balanceOf(msg.sender, uId) < amount || balanceOf(msg.sender, dId) < amount) {
            revert InsufficientBalance();
        }

        _burn(msg.sender, uId, amount);
        _burn(msg.sender, dId, amount);
        s.lockedUsdt -= amount;
        s.upSupply -= amount;
        s.downSupply -= amount;
        totalLockedUsdt -= amount;

        bool creditedToMargin = _payoutToAccount(msg.sender, amount);
        emit PositionMerged(seriesId, msg.sender, amount, creditedToMargin);
    }

    // =========================================================================
    // Settlement Redemption (Permissionless, Pause-Exempt, Aggregated Batch)
    // =========================================================================

    function redeem(bytes32 seriesId) external returns (uint256 totalPayout) {
        return redeemFor(msg.sender, seriesId);
    }

    function redeemFor(
        address account,
        bytes32 seriesId
    ) public nonReentrant returns (uint256 totalPayout) {
        if (account == address(0)) revert ZeroAddress();
        totalPayout = _redeemSeries(account, seriesId);
        _payoutToAccount(account, totalPayout);
    }

    function batchRedeem(
        bytes32[] calldata seriesIds
    ) external nonReentrant returns (uint256 totalPayout) {
        for (uint256 i = 0; i < seriesIds.length; i++) {
            totalPayout += _redeemSeries(msg.sender, seriesIds[i]);
        }
        _payoutToAccount(msg.sender, totalPayout);
    }

    // =========================================================================
    // Maker Self-Service Controls
    // =========================================================================

    function setMakerSigner(address signer, bool allowed) external {
        if (signer == address(0)) revert ZeroAddress();
        makerSigners[msg.sender][signer] = allowed;
        emit MakerSignerUpdated(msg.sender, signer, allowed);
    }

    function incrementMakerEpoch() external returns (uint64 newEpoch) {
        newEpoch = makerEpoch[msg.sender] + 1;
        makerEpoch[msg.sender] = newEpoch;
        emit MakerEpochIncremented(msg.sender, newEpoch);
    }

    function cancelNonce(uint256 nonce) external {
        _consumeNonce(msg.sender, nonce);
        emit NonceCancelled(msg.sender, nonce);
    }

    // =========================================================================
    // Governance & Role-Separated Controls (Ownable2Step + pauser + feeCollector)
    // =========================================================================

    function setPauser(address newPauser) external onlyOwner {
        if (newPauser == address(0)) revert ZeroAddress();
        pauser = newPauser;
        emit PauserUpdated(newPauser);
    }

    function setFeeCollector(address newFeeCollector) external onlyOwner {
        if (newFeeCollector == address(0)) revert ZeroAddress();
        feeCollector = newFeeCollector;
        emit FeeCollectorUpdated(newFeeCollector);
    }

    function setAssetConfig(
        bytes32 assetId,
        bool enabled,
        bool enforceStandardExpiry,
        uint64 settlementUtcOffset,
        uint64 expiryInterval
    ) external onlyOwner {
        _setAssetConfig(
            assetId,
            enabled,
            enforceStandardExpiry,
            settlementUtcOffset,
            expiryInterval
        );
    }

    function setWhitelistedMaker(address maker, bool allowed) external onlyOwner {
        if (maker == address(0)) revert ZeroAddress();
        whitelistedMakers[maker] = allowed;
        emit MakerWhitelistUpdated(maker, allowed);
    }

    function setProtocolFees(
        uint16 newOpenFeeBps,
        uint16 newCloseFeeBps
    ) external onlyOwner {
        if (
            newOpenFeeBps > MAX_OPEN_FEE_BPS ||
            newCloseFeeBps > MAX_CLOSE_FEE_BPS
        ) {
            revert FeeExceedsCap();
        }
        protocolOpenFeeBps = newOpenFeeBps;
        protocolCloseFeeBps = newCloseFeeBps;
        emit ProtocolFeesUpdated(newOpenFeeBps, newCloseFeeBps);
    }

    function setSettlementOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        settlementOracle = ISettlementOracle(newOracle);
        emit SettlementOracleUpdated(newOracle);
    }

    function collectProtocolFees(
        address recipient,
        uint256 amount
    ) external nonReentrant {
        if (msg.sender != feeCollector && msg.sender != owner()) revert Unauthorized();
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmounts();
        if (amount > accruedProtocolFees) revert InsufficientAccruedFees();

        accruedProtocolFees -= amount;
        usdt.safeTransfer(recipient, amount);
        emit ProtocolFeesCollected(recipient, amount);
    }

    function rescueToken(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmounts();

        if (token == address(usdt)) {
            uint256 required = totalLockedUsdt + totalMakerMargin + accruedProtocolFees;
            uint256 bal = usdt.balanceOf(address(this));
            uint256 surplus = bal > required ? bal - required : 0;
            if (amount > surplus) revert InsufficientSurplus();
        }

        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert Unauthorized();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // =========================================================================
    // Internal Accounting, Signature Verification, Nonce Bitmap & Active Index
    // =========================================================================

    function _setAssetConfig(
        bytes32 assetId,
        bool enabled,
        bool enforceStandardExpiry,
        uint64 settlementUtcOffset,
        uint64 expiryInterval
    ) internal {
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (
            enforceStandardExpiry &&
            (expiryInterval == 0 || settlementUtcOffset >= expiryInterval)
        ) {
            revert InvalidExpiry();
        }
        assetConfigs[assetId] = AssetConfig({
            enabled: enabled,
            enforceStandardExpiry: enforceStandardExpiry,
            settlementUtcOffset: settlementUtcOffset,
            expiryInterval: expiryInterval
        });
        emit AssetConfigUpdated(
            assetId,
            enabled,
            enforceStandardExpiry,
            settlementUtcOffset,
            expiryInterval
        );
    }

    function _validateOpenQuoteAndConsumeNonce(
        OpenQuote calldata quote,
        bytes calldata makerSignature
    ) internal {
        if (quote.taker != msg.sender) revert InvalidTaker();
        if (quote.taker == quote.maker) revert SelfTradeNotAllowed();
        if (!whitelistedMakers[quote.maker]) revert NotWhitelistedMaker();
        if (block.timestamp > quote.validUntil) revert QuoteExpired();
        if (quote.makerEpoch != makerEpoch[quote.maker]) revert InvalidMakerEpoch();

        AssetConfig memory cfg = assetConfigs[quote.assetId];
        if (!cfg.enabled) revert AssetNotEnabled();
        if (quote.lowerStrike == 0 || quote.lowerStrike >= quote.upperStrike) {
            revert InvalidStrikes();
        }
        if (quote.expiry < block.timestamp + MIN_OPEN_LEAD_TIME) {
            revert ExpiryTooSoon();
        }
        if (cfg.enforceStandardExpiry) {
            if (
                quote.expiry < cfg.settlementUtcOffset ||
                (quote.expiry - cfg.settlementUtcOffset) % cfg.expiryInterval != 0
            ) {
                revert InvalidExpiry();
            }
        }
        if (quote.userPayAmount == 0 || quote.maxPayout <= quote.userPayAmount) {
            revert InvalidAmounts();
        }
        if (quote.maxProtocolFeeBps > MAX_OPEN_FEE_BPS) revert FeeExceedsCap();
        if (protocolOpenFeeBps > quote.maxProtocolFeeBps) revert ProtocolFeeExceedsMax();

        (, bool settled) = settlementOracle.getSettlementPrice(quote.assetId, quote.expiry);
        if (settled) revert AlreadySettled();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OPEN_QUOTE_TYPEHASH,
                    quote.taker,
                    quote.maker,
                    quote.assetId,
                    quote.isUp,
                    quote.lowerStrike,
                    quote.upperStrike,
                    quote.expiry,
                    quote.userPayAmount,
                    quote.maxPayout,
                    quote.maxProtocolFeeBps,
                    quote.makerEpoch,
                    quote.validUntil,
                    quote.nonce
                )
            )
        );
        _verifyMakerSignature(quote.maker, digest, makerSignature);
        _consumeNonce(quote.maker, quote.nonce);
    }

    function _finalizeOpenQuote(
        OpenQuote calldata quote
    ) internal returns (bytes32 seriesId) {
        seriesId = getSeriesId(
            quote.assetId,
            quote.lowerStrike,
            quote.upperStrike,
            quote.expiry
        );

        Series storage s = seriesById[seriesId];
        if (s.assetId == bytes32(0)) {
            s.assetId = quote.assetId;
            s.lowerStrike = quote.lowerStrike;
            s.upperStrike = quote.upperStrike;
            s.expiry = quote.expiry;
            _seriesIdByBaseToken[upTokenId(seriesId)] = seriesId;
            _allSeriesIds.push(seriesId);
        }

        uint256 protocolFee;
        {
            uint256 feeBps = protocolOpenFeeBps;
            protocolFee = (quote.userPayAmount * feeBps) / (10_000 + feeBps);
            uint256 mmPremium = quote.userPayAmount - protocolFee;
            uint256 makerCollateral = quote.maxPayout - mmPremium;

            if (makerMargin[quote.maker] < makerCollateral) {
                revert InsufficientMakerMargin();
            }
            makerMargin[quote.maker] -= makerCollateral;
            totalMakerMargin -= makerCollateral;

            if (protocolFee > 0) {
                accruedProtocolFees += protocolFee;
            }
        }

        s.lockedUsdt += quote.maxPayout;
        s.upSupply += quote.maxPayout;
        s.downSupply += quote.maxPayout;
        totalLockedUsdt += quote.maxPayout;

        uint256 uId = upTokenId(seriesId);
        uint256 dId = downTokenId(seriesId);
        (uint256 takerTokenId, uint256 makerTokenId) = quote.isUp
            ? (uId, dId)
            : (dId, uId);
        _mint(quote.taker, takerTokenId, quote.maxPayout, "");
        _mint(quote.maker, makerTokenId, quote.maxPayout, "");

        emit TicketOpened(
            seriesId,
            quote.taker,
            quote.maker,
            quote.assetId,
            quote.isUp,
            quote.lowerStrike,
            quote.upperStrike,
            quote.expiry,
            quote.userPayAmount,
            protocolFee,
            quote.maxPayout,
            quote.nonce
        );
    }

    function _validateCloseQuoteAndConsumeNonce(
        CloseQuote calldata quote,
        bytes calldata makerSignature
    ) internal {
        if (quote.taker != msg.sender) revert InvalidTaker();
        if (quote.taker == quote.maker) revert SelfTradeNotAllowed();
        if (!whitelistedMakers[quote.maker]) revert NotWhitelistedMaker();
        if (block.timestamp > quote.validUntil) revert QuoteExpired();
        if (quote.makerEpoch != makerEpoch[quote.maker]) revert InvalidMakerEpoch();
        if (
            quote.amount == 0 ||
            quote.buybackAmount == 0 ||
            quote.buybackAmount > quote.amount
        ) {
            revert InvalidAmounts();
        }
        if (quote.maxCloseFeeBps > MAX_CLOSE_FEE_BPS) revert FeeExceedsCap();
        if (protocolCloseFeeBps > quote.maxCloseFeeBps) revert ProtocolFeeExceedsMax();

        Series storage s = seriesById[quote.seriesId];
        if (s.assetId == bytes32(0)) revert SeriesDoesNotExist();
        (, bool settled) = settlementOracle.getSettlementPrice(s.assetId, s.expiry);
        if (settled) revert AlreadySettled();
        if (block.timestamp + MIN_CLOSE_LEAD_TIME > s.expiry) {
            revert CloseWindowElapsed();
        }

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CLOSE_QUOTE_TYPEHASH,
                    quote.taker,
                    quote.maker,
                    quote.seriesId,
                    quote.isUp,
                    quote.amount,
                    quote.buybackAmount,
                    quote.maxCloseFeeBps,
                    quote.makerEpoch,
                    quote.validUntil,
                    quote.nonce
                )
            )
        );
        _verifyMakerSignature(quote.maker, digest, makerSignature);
        _consumeNonce(quote.maker, quote.nonce);
    }

    function _executeCloseQuote(CloseQuote calldata quote) internal {
        uint256 mergeQty;
        uint256 transferQty;
        uint256 takerTokenId = quote.isUp
            ? upTokenId(quote.seriesId)
            : downTokenId(quote.seriesId);
        {
            uint256 makerCompTokenId = quote.isUp
                ? downTokenId(quote.seriesId)
                : upTokenId(quote.seriesId);

            if (balanceOf(quote.taker, takerTokenId) < quote.amount) {
                revert InsufficientBalance();
            }

            uint256 makerCompBal = balanceOf(quote.maker, makerCompTokenId);
            mergeQty = quote.amount <= makerCompBal ? quote.amount : makerCompBal;
            transferQty = quote.amount - mergeQty;

            if (mergeQty > 0) {
                _burn(quote.taker, takerTokenId, mergeQty);
                _burn(quote.maker, makerCompTokenId, mergeQty);
                Series storage s = seriesById[quote.seriesId];
                s.lockedUsdt -= mergeQty;
                s.upSupply -= mergeQty;
                s.downSupply -= mergeQty;
                totalLockedUsdt -= mergeQty;
            }
        }

        uint256 closeFee = (quote.buybackAmount * uint256(protocolCloseFeeBps)) / 10_000;
        uint256 userNetPayout = quote.buybackAmount - closeFee;
        if (closeFee > 0) {
            accruedProtocolFees += closeFee;
        }

        if (mergeQty >= quote.buybackAmount) {
            uint256 makerRefund = mergeQty - quote.buybackAmount;
            if (makerRefund > 0) {
                makerMargin[quote.maker] += makerRefund;
                totalMakerMargin += makerRefund;
                emit MakerMarginCredited(quote.maker, makerRefund);
            }
        } else {
            uint256 makerTopUp = quote.buybackAmount - mergeQty;
            if (makerMargin[quote.maker] < makerTopUp) {
                revert InsufficientMakerMargin();
            }
            makerMargin[quote.maker] -= makerTopUp;
            totalMakerMargin -= makerTopUp;
        }

        if (transferQty > 0) {
            _safeTransferFrom(quote.taker, quote.maker, takerTokenId, transferQty, "");
        }

        if (userNetPayout > 0) {
            usdt.safeTransfer(quote.taker, userNetPayout);
        }

        emit TicketClosedEarly(
            quote.seriesId,
            quote.taker,
            quote.maker,
            quote.isUp,
            quote.amount,
            quote.buybackAmount,
            closeFee,
            mergeQty,
            transferQty,
            quote.nonce
        );
    }

    function _redeemSeries(
        address account,
        bytes32 seriesId
    ) internal returns (uint256 totalPayout) {
        Series storage s = seriesById[seriesId];
        if (s.assetId == bytes32(0)) revert SeriesDoesNotExist();

        (uint64 settlementPrice, bool settled) = settlementOracle.getSettlementPrice(
            s.assetId,
            s.expiry
        );
        if (!settled) revert NotSettled();

        uint256 uId = upTokenId(seriesId);
        uint256 dId = downTokenId(seriesId);
        uint256 upBal = balanceOf(account, uId);
        uint256 downBal = balanceOf(account, dId);
        if (upBal == 0 && downBal == 0) revert InsufficientBalance();

        (uint256 upPayout, uint256 downPayout) = _computePayout(
            s.lowerStrike,
            s.upperStrike,
            settlementPrice,
            upBal,
            downBal
        );
        totalPayout = upPayout + downPayout;

        if (upBal > 0) {
            _burn(account, uId, upBal);
            s.upSupply -= upBal;
        }
        if (downBal > 0) {
            _burn(account, dId, downBal);
            s.downSupply -= downBal;
        }

        if (totalPayout > 0) {
            s.lockedUsdt -= totalPayout;
            totalLockedUsdt -= totalPayout;
        }

        // Sweep floor-rounding dust into accruedProtocolFees once all tokens are burned
        if (s.upSupply == 0 && s.downSupply == 0) {
            uint256 dust = s.lockedUsdt;
            if (dust > 0) {
                s.lockedUsdt = 0;
                totalLockedUsdt -= dust;
                accruedProtocolFees += dust;
            }
        }

        emit TicketRedeemed(
            seriesId,
            account,
            upBal,
            downBal,
            upPayout,
            downPayout,
            whitelistedMakers[account]
        );
    }

    function _computePayout(
        uint64 lowerStrike,
        uint64 upperStrike,
        uint64 settlementPrice,
        uint256 upAmount,
        uint256 downAmount
    ) internal pure returns (uint256 upPayout, uint256 downPayout) {
        uint256 width = uint256(upperStrike) - uint256(lowerStrike);
        uint256 upNumerator;
        if (settlementPrice <= lowerStrike) {
            upNumerator = 0;
        } else if (settlementPrice >= upperStrike) {
            upNumerator = width;
        } else {
            upNumerator = uint256(settlementPrice) - uint256(lowerStrike);
        }

        // Floor rounding via 512-bit mulDiv guarantees upPayout(A) + downPayout(A) <= A without overflow.
        if (upAmount > 0) {
            upPayout = Math.mulDiv(upAmount, upNumerator, width);
        }
        if (downAmount > 0) {
            downPayout = Math.mulDiv(downAmount, width - upNumerator, width);
        }
    }

    function _payoutToAccount(
        address account,
        uint256 amount
    ) internal returns (bool creditedToMargin) {
        if (amount == 0) return whitelistedMakers[account];
        if (whitelistedMakers[account]) {
            makerMargin[account] += amount;
            totalMakerMargin += amount;
            emit MakerMarginCredited(account, amount);
            return true;
        }
        usdt.safeTransfer(account, amount);
        return false;
    }

    function _verifyMakerSignature(
        address maker,
        bytes32 digest,
        bytes calldata signature
    ) internal view {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
            digest,
            signature
        );
        if (
            err == ECDSA.RecoverError.NoError &&
            recovered != address(0) &&
            (recovered == maker || makerSigners[maker][recovered])
        ) {
            return;
        }
        if (
            maker.code.length > 0 &&
            SignatureChecker.isValidERC1271SignatureNow(maker, digest, signature)
        ) {
            return;
        }
        revert InvalidSignature();
    }

    function _consumeNonce(address maker, uint256 nonce) internal {
        uint256 wordPos = nonce >> 8;
        uint256 bitPos = nonce & 0xff;
        uint256 mask = uint256(1) << bitPos;
        uint256 word = _makerNonceBitmap[maker][wordPos];
        if ((word & mask) != 0) revert NonceAlreadyUsed();
        _makerNonceBitmap[maker][wordPos] = word | mask;
    }

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        super._update(from, to, ids, values);
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];
            if (values[i] > 0) {
                bytes32 sid = _seriesIdByBaseToken[id & ~uint256(1)];
                if (sid != bytes32(0)) {
                    if (to != address(0) && balanceOf(to, id) > 0) {
                        _userActiveTokens[to].add(id);
                    }
                    if (from != address(0) && balanceOf(from, id) == 0) {
                        _userActiveTokens[from].remove(id);
                    }
                }
            }
        }
    }
}
