// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSDT
 * @notice 6-decimal Tether USD testnet collateral token for BNB Smart Chain Testnet
 *         and local Hardhat devnet.
 *         Supports public `faucet()` (1,000 tUSDT), capped public `faucet(uint256)`
 *         (up to 100,000 tUSDT per call), owner `mint(address, uint256)`, and
 *         owner `setFrozen(address, bool)` test hook for freeze-resistance testing.
 */
contract MockUSDT is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000 * 1e6;
    uint256 public constant MAX_PUBLIC_FAUCET_AMOUNT = 100_000 * 1e6;

    mapping(address => bool) public frozen;

    event AccountFrozenUpdated(address indexed account, bool isFrozen);

    error AccountFrozen(address account);
    error InvalidAmount();
    error FaucetCapExceeded(uint256 requested, uint256 cap);

    constructor(address initialOwner)
        ERC20("Tether USD (Testnet)", "tUSDT")
        Ownable(initialOwner)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function faucet(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        if (amount > MAX_PUBLIC_FAUCET_AMOUNT) {
            revert FaucetCapExceeded(amount, MAX_PUBLIC_FAUCET_AMOUNT);
        }
        _mint(msg.sender, amount);
    }

    function setFrozen(address account, bool isFrozen) external onlyOwner {
        frozen[account] = isFrozen;
        emit AccountFrozenUpdated(account, isFrozen);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && frozen[from]) revert AccountFrozen(from);
        if (to != address(0) && frozen[to]) revert AccountFrozen(to);
        super._update(from, to, value);
    }
}
