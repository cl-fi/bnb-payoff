// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ISettlementOracle
 * @notice Minimal settlement oracle interface consumed by PayoffSpreadVault.
 *         Decouples settlement price discovery from the collateral vault so the
 *         oracle implementation can be swapped later without redeploying the vault.
 */
interface ISettlementOracle {
    struct SettlementData {
        uint64 price; // 8-decimal USD settlement price
        uint64 settledAt; // unix timestamp when settlement was recorded
        bool settled;
    }

    function getSettlementPrice(
        bytes32 assetId,
        uint64 expiry
    ) external view returns (uint64 price, bool settled);

    function getSettlement(
        bytes32 assetId,
        uint64 expiry
    ) external view returns (SettlementData memory);
}
