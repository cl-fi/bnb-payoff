// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISettlementOracle} from "./ISettlementOracle.sol";

interface IPayoffSpreadVaultView {
    function settlementOracle() external view returns (ISettlementOracle);
    function protocolOpenFeeBps() external view returns (uint16);
    function protocolCloseFeeBps() external view returns (uint16);
    function paused() external view returns (bool);
    function whitelistedMakers(address maker) external view returns (bool);
    function makerMargin(address maker) external view returns (uint256);
    function makerEpoch(address maker) external view returns (uint64);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function vaultHealth()
        external
        view
        returns (
            uint256 usdtBalance,
            uint256 lockedUsdt,
            uint256 makerMarginUsdt,
            uint256 protocolFeesUsdt,
            bool isSolvent
        );
    function seriesById(bytes32 seriesId)
        external
        view
        returns (
            bytes32 assetId,
            uint64 lowerStrike,
            uint64 upperStrike,
            uint64 expiry,
            uint256 lockedUsdt,
            uint256 upSupply,
            uint256 downSupply
        );
    function previewPayout(
        bytes32 seriesId,
        uint256 upAmount,
        uint256 downAmount
    ) external view returns (uint256 upPayout, uint256 downPayout);
    function getUserActiveTokenCount(address user) external view returns (uint256);
    function getUserActiveTokenAt(address user, uint256 index) external view returns (uint256);
    function getSeriesIdByToken(uint256 tokenId) external view returns (bytes32);
    function getAllSeriesCount() external view returns (uint256);
    function getSeriesIdAt(uint256 index) external view returns (bytes32);
}

/**
 * @title PayoffVaultLens
 * @notice Stateless read-only periphery lens for PayoffSpreadVault.
 *         Holds zero funds and zero state; replaceable at any time without touching the core vault.
 */
contract PayoffVaultLens {
    struct ActivePositionView {
        uint256 tokenId;
        bytes32 seriesId;
        bytes32 assetId;
        bool isUp;
        uint64 lowerStrike;
        uint64 upperStrike;
        uint64 expiry;
        uint256 balance;
        bool settled;
        uint64 settlementPrice;
        uint256 claimableUsdt;
    }

    struct SeriesInfo {
        bytes32 seriesId;
        bytes32 assetId;
        uint64 lowerStrike;
        uint64 upperStrike;
        uint64 expiry;
    }

    function getUserActivePositions(
        address vaultAddr,
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (ActivePositionView[] memory items, uint256 total) {
        IPayoffSpreadVaultView vault = IPayoffSpreadVaultView(vaultAddr);
        total = vault.getUserActiveTokenCount(user);
        if (offset >= total || limit == 0) {
            return (new ActivePositionView[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 len = end - offset;
        items = new ActivePositionView[](len);

        ISettlementOracle oracle = vault.settlementOracle();

        for (uint256 i = 0; i < len; i++) {
            uint256 tokenId = vault.getUserActiveTokenAt(user, offset + i);
            bytes32 sid = vault.getSeriesIdByToken(tokenId);
            bool isUp = (tokenId & 1) == 0;
            (bytes32 assetId, uint64 lowerStrike, uint64 upperStrike, uint64 expiry, , , ) = vault
                .seriesById(sid);
            uint256 bal = vault.balanceOf(user, tokenId);
            (uint64 settlementPrice, bool settled) = oracle.getSettlementPrice(assetId, expiry);

            uint256 claimable = 0;
            if (settled && bal > 0) {
                (uint256 upPay, uint256 downPay) = vault.previewPayout(
                    sid,
                    isUp ? bal : 0,
                    isUp ? 0 : bal
                );
                claimable = isUp ? upPay : downPay;
            }

            items[i] = ActivePositionView({
                tokenId: tokenId,
                seriesId: sid,
                assetId: assetId,
                isUp: isUp,
                lowerStrike: lowerStrike,
                upperStrike: upperStrike,
                expiry: expiry,
                balance: bal,
                settled: settled,
                settlementPrice: settlementPrice,
                claimableUsdt: claimable
            });
        }
    }

    function getAllSeries(
        address vaultAddr,
        uint256 offset,
        uint256 limit
    ) external view returns (SeriesInfo[] memory items, uint256 total) {
        IPayoffSpreadVaultView vault = IPayoffSpreadVaultView(vaultAddr);
        total = vault.getAllSeriesCount();
        if (offset >= total || limit == 0) {
            return (new SeriesInfo[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 len = end - offset;
        items = new SeriesInfo[](len);

        for (uint256 i = 0; i < len; i++) {
            bytes32 sid = vault.getSeriesIdAt(offset + i);
            (bytes32 assetId, uint64 lowerStrike, uint64 upperStrike, uint64 expiry, , , ) = vault
                .seriesById(sid);
            items[i] = SeriesInfo({
                seriesId: sid,
                assetId: assetId,
                lowerStrike: lowerStrike,
                upperStrike: upperStrike,
                expiry: expiry
            });
        }
    }

    function getMakerOverview(
        address vaultAddr,
        address maker
    ) external view returns (bool whitelisted, uint256 margin, uint64 epoch) {
        IPayoffSpreadVaultView vault = IPayoffSpreadVaultView(vaultAddr);
        whitelisted = vault.whitelistedMakers(maker);
        margin = vault.makerMargin(maker);
        epoch = vault.makerEpoch(maker);
    }

    function getVaultOverview(
        address vaultAddr
    )
        external
        view
        returns (
            uint256 usdtBalance,
            uint256 lockedUsdt,
            uint256 makerMarginUsdt,
            uint256 protocolFeesUsdt,
            bool isSolvent,
            uint16 openFeeBps,
            uint16 closeFeeBps,
            address oracle,
            bool isPaused
        )
    {
        IPayoffSpreadVaultView vault = IPayoffSpreadVaultView(vaultAddr);
        (usdtBalance, lockedUsdt, makerMarginUsdt, protocolFeesUsdt, isSolvent) = vault
            .vaultHealth();
        openFeeBps = vault.protocolOpenFeeBps();
        closeFeeBps = vault.protocolCloseFeeBps();
        oracle = address(vault.settlementOracle());
        isPaused = vault.paused();
    }
}
