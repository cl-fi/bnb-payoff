import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";
import {
  ASSET_BTC_ID,
  ASSET_ETH_ID,
  computeDownTokenId,
  computeProtocolFee,
  computeSeriesId,
  computeUpTokenId,
  symbolToAssetId,
} from "@payoff/shared";
import {
  FEED_ID_BTC,
  FEED_ID_ETH,
  settleExpiryWithCustomAtlasProof,
} from "./helpers/atlasProof";

function nextUtcAtOffset(nowSec: number, daysAhead: number, offsetSec: number): number {
  const daySec = 86400;
  const baseDay = Math.floor((nowSec - offsetSec) / daySec) + daysAhead;
  return baseDay * daySec + offsetSec;
}

function next08Utc(nowSec: number, daysAhead: number): number {
  return nextUtcAtOffset(nowSec, daysAhead, 8 * 3600);
}

describe("PayoffSpreadVault (Core), PayoffVaultLens & AtlasPullSettlementOracle", function () {
  const OPEN_TYPES = {
    OpenQuote: [
      { name: "taker", type: "address" },
      { name: "maker", type: "address" },
      { name: "assetId", type: "bytes32" },
      { name: "isUp", type: "bool" },
      { name: "lowerStrike", type: "uint64" },
      { name: "upperStrike", type: "uint64" },
      { name: "expiry", type: "uint64" },
      { name: "userPayAmount", type: "uint256" },
      { name: "maxPayout", type: "uint256" },
      { name: "maxProtocolFeeBps", type: "uint16" },
      { name: "makerEpoch", type: "uint64" },
      { name: "validUntil", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const CLOSE_TYPES = {
    CloseQuote: [
      { name: "taker", type: "address" },
      { name: "maker", type: "address" },
      { name: "seriesId", type: "bytes32" },
      { name: "isUp", type: "bool" },
      { name: "amount", type: "uint256" },
      { name: "buybackAmount", type: "uint256" },
      { name: "maxCloseFeeBps", type: "uint16" },
      { name: "makerEpoch", type: "uint64" },
      { name: "validUntil", type: "uint64" },
      { name: "nonce", type: "uint256" },
    ],
  };

  async function deployFixture() {
    const [
      admin,
      mm1,
      mm2,
      taker,
      keeper,
      pauser,
      feeCollector,
      hotSigner,
      stranger,
      newAdmin,
    ] = await ethers.getSigners();

    const atlasSigner = ethers.Wallet.createRandom();

    const MockUSDT = await ethers.getContractFactory("MockUSDT");
    const usdt = await MockUSDT.deploy(admin.address);

    const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
    const oracle = await Oracle.deploy(admin.address, atlasSigner.address);

    const Vault = await ethers.getContractFactory("PayoffSpreadVault");
    const vault = await Vault.deploy(
      await usdt.getAddress(),
      await oracle.getAddress(),
      admin.address,
      400, // 4% open fee
      0 // 0% close fee initially
    );

    const Lens = await ethers.getContractFactory("PayoffVaultLens");
    const lens = await Lens.deploy();

    const vaultAddr = await vault.getAddress();
    const lensAddr = await lens.getAddress();
    const usdtAddr = await usdt.getAddress();

    // Lightweight role separation (Ownable2Step + dedicated pauser & feeCollector)
    await vault.setPauser(pauser.address);
    await vault.setFeeCollector(feeCollector.address);

    // Whitelist & pre-fund makerMargin (exact finite approval, zero standing MaxUint256)
    await vault.setWhitelistedMaker(mm1.address, true);
    await vault.setWhitelistedMaker(mm2.address, true);

    const mmFund = ethers.parseUnits("500000", 6);
    const takerFund = ethers.parseUnits("10000", 6);
    await usdt.mint(mm1.address, mmFund);
    await usdt.mint(mm2.address, mmFund);
    await usdt.mint(taker.address, takerFund);

    await usdt.connect(mm1).approve(vaultAddr, mmFund);
    await vault.connect(mm1).depositMakerMargin(mmFund);

    await usdt.connect(mm2).approve(vaultAddr, mmFund);
    await vault.connect(mm2).depositMakerMargin(mmFund);

    // Verify MMs have 0 standing allowance after deposit
    expect(await usdt.allowance(mm1.address, vaultAddr)).to.equal(0n);
    expect(await usdt.allowance(mm2.address, vaultAddr)).to.equal(0n);

    // Standard approval for taker in baseline tests
    await usdt.connect(taker).approve(vaultAddr, ethers.MaxUint256);

    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const domain = {
      name: "PayoffSpreadVault",
      version: "2",
      chainId,
      verifyingContract: vaultAddr,
    };

    return {
      admin,
      mm1,
      mm2,
      taker,
      keeper,
      pauser,
      feeCollector,
      hotSigner,
      stranger,
      newAdmin,
      atlasSigner,
      usdt,
      oracle,
      vault,
      lens,
      vaultAddr,
      lensAddr,
      usdtAddr,
      chainId,
      domain,
    };
  }

  async function assertVaultSolvent(vault: any) {
    const [bal, locked, margin, fees, isSolvent] = await vault.vaultHealth();
    expect(isSolvent).to.equal(true);
    expect(bal).to.be.greaterThanOrEqual(locked + margin + fees);
    return { bal, locked, margin, fees, isSolvent };
  }

  it("opens complementary UP and DOWN tickets on the same 4-tuple seriesId, accrues fees, merges 1:1, and queries cleanly via PayoffVaultLens", async function () {
    const { mm1, taker, feeCollector, usdt, vault, lens, vaultAddr, domain } =
      await deployFixture();

    const now = await time.latest();
    const expiry = next08Utc(now, 2);
    const lowerStrike = 90000_00000000n;
    const upperStrike = 92700_00000000n;
    const userPayAmount = ethers.parseUnits("20", 6);
    const maxPayout = ethers.parseUnits("50", 6);

    const expectedSid = computeSeriesId(ASSET_BTC_ID, lowerStrike, upperStrike, expiry);
    expect(await vault.getSeriesId(ASSET_BTC_ID, lowerStrike, upperStrike, expiry)).to.equal(
      expectedSid
    );

    // 1. Taker buys UP (bullish)
    const upQuote = {
      taker: taker.address,
      maker: mm1.address,
      assetId: ASSET_BTC_ID,
      isUp: true,
      lowerStrike,
      upperStrike,
      expiry,
      userPayAmount,
      maxPayout,
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 120,
      nonce: 1n,
    };
    const upSig = await mm1.signTypedData(domain, OPEN_TYPES, upQuote);
    const mm1MarginBefore = await vault.makerMargin(mm1.address);
    const takerUsdtBefore = await usdt.balanceOf(taker.address);

    await expect(vault.connect(taker).fillOpenQuote(upQuote, upSig)).to.emit(
      vault,
      "TicketOpened"
    );

    const expectedFee = computeProtocolFee(userPayAmount, 400);
    const expectedMmCollateral = maxPayout - (userPayAmount - expectedFee);

    expect(takerUsdtBefore - (await usdt.balanceOf(taker.address))).to.equal(userPayAmount);
    expect(mm1MarginBefore - (await vault.makerMargin(mm1.address))).to.equal(
      expectedMmCollateral
    );
    expect(await vault.accruedProtocolFees()).to.equal(expectedFee);
    expect(await vault.balanceOf(taker.address, computeUpTokenId(expectedSid))).to.equal(
      maxPayout
    );
    expect(await vault.balanceOf(mm1.address, computeDownTokenId(expectedSid))).to.equal(
      maxPayout
    );

    // 2. Same taker buys DOWN (bearish) on the EXACT SAME seriesId
    const downQuote = {
      ...upQuote,
      isUp: false,
      nonce: 2n,
    };
    const downSig = await mm1.signTypedData(domain, OPEN_TYPES, downQuote);
    await vault.connect(taker).fillOpenQuote(downQuote, downSig);

    // Taker now holds BOTH 50 UP and 50 DOWN on the same seriesId
    expect(await vault.balanceOf(taker.address, computeUpTokenId(expectedSid))).to.equal(
      maxPayout
    );
    expect(await vault.balanceOf(taker.address, computeDownTokenId(expectedSid))).to.equal(
      maxPayout
    );
    expect(await vault.getUserActiveTokenCount(taker.address)).to.equal(2n);

    const [activePositions, total] = await lens.getUserActivePositions(
      vaultAddr,
      taker.address,
      0,
      10
    );
    expect(total).to.equal(2n);
    expect(activePositions.map((p) => p.isUp).sort()).to.deep.equal([false, true]);
    expect(activePositions[0].seriesId).to.equal(expectedSid);
    expect(activePositions[1].seriesId).to.equal(expectedSid);

    // 3. Taker merges 30 UP + 30 DOWN 1:1 to unlock 30 tUSDT directly to wallet
    const mergeAmt = ethers.parseUnits("30", 6);
    const takerBeforeMerge = await usdt.balanceOf(taker.address);
    await expect(vault.connect(taker).merge(expectedSid, mergeAmt))
      .to.emit(vault, "PositionMerged")
      .withArgs(expectedSid, taker.address, mergeAmt, false);
    expect((await usdt.balanceOf(taker.address)) - takerBeforeMerge).to.equal(mergeAmt);

    // 4. Maker also holds 50 DOWN + 50 UP -> merges 50 1:1 into makerMargin
    const mm1MarginBeforeMerge = await vault.makerMargin(mm1.address);
    await expect(vault.connect(mm1).merge(expectedSid, maxPayout))
      .to.emit(vault, "PositionMerged")
      .withArgs(expectedSid, mm1.address, maxPayout, true);
    expect((await vault.makerMargin(mm1.address)) - mm1MarginBeforeMerge).to.equal(maxPayout);

    // 5. Pull protocol fees via feeCollector
    const accrued = await vault.accruedProtocolFees();
    expect(accrued).to.equal(expectedFee * 2n);
    const collectorBefore = await usdt.balanceOf(feeCollector.address);
    await expect(vault.connect(feeCollector).collectProtocolFees(feeCollector.address, accrued))
      .to.emit(vault, "ProtocolFeesCollected")
      .withArgs(feeCollector.address, accrued);
    expect((await usdt.balanceOf(feeCollector.address)) - collectorBefore).to.equal(accrued);
    expect(await vault.accruedProtocolFees()).to.equal(0n);

    await assertVaultSolvent(vault);
  });

  it("verifies PayoffVaultLens overview reads, AtlasPullSettlementOracle guards, and Core/Periphery bytecode headroom", async function () {
    const { mm1, taker, stranger, atlasSigner, oracle, vault, lens, vaultAddr, domain } =
      await deployFixture();
    const now = await time.latest();
    const expiry = next08Utc(now, 2);

    // 1. Bytecode size budget assertions at optimizer.runs = 200 (well under EIP-170 24,576B limit)
    const artifactsRoot = path.resolve(__dirname, "../artifacts/contracts");
    const vaultArtifact = JSON.parse(
      fs.readFileSync(
        path.join(artifactsRoot, "PayoffSpreadVault.sol/PayoffSpreadVault.json"),
        "utf8"
      )
    );
    const lensArtifact = JSON.parse(
      fs.readFileSync(
        path.join(artifactsRoot, "PayoffVaultLens.sol/PayoffVaultLens.json"),
        "utf8"
      )
    );
    const oracleArtifact = JSON.parse(
      fs.readFileSync(
        path.join(
          artifactsRoot,
          "AtlasPullSettlementOracle.sol/AtlasPullSettlementOracle.json"
        ),
        "utf8"
      )
    );
    const vaultBytes = (vaultArtifact.deployedBytecode.length - 2) / 2;
    const lensBytes = (lensArtifact.deployedBytecode.length - 2) / 2;
    const oracleBytes = (oracleArtifact.deployedBytecode.length - 2) / 2;

    expect(vaultBytes).to.be.lessThanOrEqual(20_500);
    expect(lensBytes).to.be.lessThanOrEqual(6_000);
    expect(oracleBytes).to.be.lessThanOrEqual(10_000);

    // 2. AtlasPullSettlementOracle guards: expiry == 0 & unauthorized signer rejected
    await expect(
      settleExpiryWithCustomAtlasProof({
        oracle,
        caller: stranger,
        signerPrivateKey: atlasSigner.privateKey,
        assetId: ASSET_BTC_ID,
        feedId: FEED_ID_BTC,
        expiry: 0,
        price8: 62000_00000000n,
      })
    ).to.be.revertedWithCustomError(oracle, "InvalidExpiry");

    const rogueSigner = ethers.Wallet.createRandom();
    await expect(
      settleExpiryWithCustomAtlasProof({
        oracle,
        caller: stranger,
        signerPrivateKey: rogueSigner.privateKey,
        assetId: ASSET_BTC_ID,
        feedId: FEED_ID_BTC,
        expiry: now - 10,
        price8: 62000_00000000n,
      })
    ).to.be.revertedWithCustomError(oracle, "UnauthorizedSigner");

    // 3. PayoffVaultLens getMakerOverview & getVaultOverview
    const [whitelisted, margin, epoch] = await lens.getMakerOverview(vaultAddr, mm1.address);
    expect(whitelisted).to.equal(true);
    expect(margin).to.equal(ethers.parseUnits("500000", 6));
    expect(epoch).to.equal(0n);

    const q = {
      taker: taker.address,
      maker: mm1.address,
      assetId: ASSET_BTC_ID,
      isUp: true,
      lowerStrike: 62000_00000000n,
      upperStrike: 64000_00000000n,
      expiry,
      userPayAmount: ethers.parseUnits("20", 6),
      maxPayout: ethers.parseUnits("50", 6),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 11n,
    };
    await vault.connect(taker).fillOpenQuote(q, await mm1.signTypedData(domain, OPEN_TYPES, q));

    const overview = await lens.getVaultOverview(vaultAddr);
    expect(overview.isSolvent).to.equal(true);
    expect(overview.lockedUsdt).to.equal(ethers.parseUnits("50", 6));
    expect(overview.openFeeBps).to.equal(400n);
    expect(overview.closeFeeBps).to.equal(0n);
    expect(overview.oracle).to.equal(await oracle.getAddress());
    expect(overview.isPaused).to.equal(false);
  });

  it("supports delegated maker hot signers, EIP-1271 contract makers, makerEpoch kill switch, bitmap nonces, and blocks self-trade", async function () {
    const { admin, mm1, taker, hotSigner, stranger, usdt, vault, vaultAddr, domain } =
      await deployFixture();
    const now = await time.latest();
    const expiry = next08Utc(now, 2);

    // 1. Self-trade blocked
    const selfQuote = {
      taker: mm1.address,
      maker: mm1.address,
      assetId: ASSET_BTC_ID,
      isUp: true,
      lowerStrike: 62000_00000000n,
      upperStrike: 64000_00000000n,
      expiry,
      userPayAmount: ethers.parseUnits("20", 6),
      maxPayout: ethers.parseUnits("50", 6),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 1n,
    };
    const selfSig = await mm1.signTypedData(domain, OPEN_TYPES, selfQuote);
    await expect(
      vault.connect(mm1).fillOpenQuote(selfQuote, selfSig)
    ).to.be.revertedWithCustomError(vault, "SelfTradeNotAllowed");

    // 2. Delegated hot signer: rejected before approval, succeeds after, rejected after revocation
    const delegatedQuote = {
      ...selfQuote,
      taker: taker.address,
      nonce: 256n, // wordPos=1, bitPos=0
    };
    const hotSig = await hotSigner.signTypedData(domain, OPEN_TYPES, delegatedQuote);
    await expect(
      vault.connect(taker).fillOpenQuote(delegatedQuote, hotSig)
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    await vault.connect(mm1).setMakerSigner(hotSigner.address, true);
    await expect(vault.connect(taker).fillOpenQuote(delegatedQuote, hotSig)).to.emit(
      vault,
      "TicketOpened"
    );
    expect(await vault.isNonceUsed(mm1.address, 256n)).to.equal(true);
    expect(await vault.isNonceUsed(mm1.address, 257n)).to.equal(false);

    // Replay same bitmap nonce fails
    await expect(
      vault.connect(taker).fillOpenQuote(delegatedQuote, hotSig)
    ).to.be.revertedWithCustomError(vault, "NonceAlreadyUsed");

    // Revoke hot signer -> rejected
    await vault.connect(mm1).setMakerSigner(hotSigner.address, false);
    const delegatedQuote2 = { ...delegatedQuote, nonce: 257n };
    const hotSig2 = await hotSigner.signTypedData(domain, OPEN_TYPES, delegatedQuote2);
    await expect(
      vault.connect(taker).fillOpenQuote(delegatedQuote2, hotSig2)
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    // 3. Maker Epoch kill switch invalidates old-epoch quotes immediately
    const oldEpochQuote = { ...delegatedQuote, nonce: 511n }; // wordPos=1, bitPos=255
    const oldEpochSig = await mm1.signTypedData(domain, OPEN_TYPES, oldEpochQuote);
    await expect(vault.connect(mm1).incrementMakerEpoch())
      .to.emit(vault, "MakerEpochIncremented")
      .withArgs(mm1.address, 1n);

    await expect(
      vault.connect(taker).fillOpenQuote(oldEpochQuote, oldEpochSig)
    ).to.be.revertedWithCustomError(vault, "InvalidMakerEpoch");

    // New epoch quote succeeds
    const newEpochQuote = { ...oldEpochQuote, makerEpoch: 1n };
    const newEpochSig = await mm1.signTypedData(domain, OPEN_TYPES, newEpochQuote);
    await expect(vault.connect(taker).fillOpenQuote(newEpochQuote, newEpochSig)).to.emit(
      vault,
      "TicketOpened"
    );

    // 4. EIP-1271 Smart Contract Maker
    const MockWallet = await ethers.getContractFactory("MockERC1271Wallet");
    const smartMaker = await MockWallet.deploy(stranger.address);
    const smartMakerAddr = await smartMaker.getAddress();

    await vault.connect(admin).setWhitelistedMaker(smartMakerAddr, true);
    const smFund = ethers.parseUnits("10000", 6);
    await usdt.mint(smartMakerAddr, smFund);

    const approveData = usdt.interface.encodeFunctionData("approve", [vaultAddr, smFund]);
    await smartMaker.connect(stranger).execute(await usdt.getAddress(), approveData);
    const depositData = vault.interface.encodeFunctionData("depositMakerMargin", [smFund]);
    await smartMaker.connect(stranger).execute(vaultAddr, depositData);
    expect(await vault.makerMargin(smartMakerAddr)).to.equal(smFund);

    const smQuote = {
      ...delegatedQuote,
      maker: smartMakerAddr,
      makerEpoch: 0n,
      nonce: 10000n,
    };
    const smSig = await stranger.signTypedData(domain, OPEN_TYPES, smQuote);
    await expect(vault.connect(taker).fillOpenQuote(smQuote, smSig)).to.emit(
      vault,
      "TicketOpened"
    );

    const badSmQuote = { ...smQuote, nonce: 10001n };
    const badSmSig = await hotSigner.signTypedData(domain, OPEN_TYPES, badSmQuote);
    await expect(
      vault.connect(taker).fillOpenQuote(badSmQuote, badSmSig)
    ).to.be.revertedWithCustomError(vault, "InvalidSignature");

    await assertVaultSolvent(vault);
  });

  it("enforces on-chain fee controls, quote fee slippage caps, and handles UP/DOWN early close (merge, takeover, hybrid)", async function () {
    const { admin, mm1, mm2, taker, usdt, vault, domain } = await deployFixture();
    const now = await time.latest();
    const expiry = next08Utc(now, 2);

    await expect(vault.connect(admin).setProtocolFees(501, 0)).to.be.revertedWithCustomError(
      vault,
      "FeeExceedsCap"
    );
    await expect(vault.connect(admin).setProtocolFees(400, 101)).to.be.revertedWithCustomError(
      vault,
      "FeeExceedsCap"
    );

    const baseOpen = {
      taker: taker.address,
      maker: mm1.address,
      assetId: ASSET_BTC_ID,
      isUp: false, // BEAR (DOWN) spread lifecycle
      lowerStrike: 60000_00000000n,
      upperStrike: 62000_00000000n,
      expiry,
      userPayAmount: ethers.parseUnits("20", 6),
      maxPayout: ethers.parseUnits("60", 6),
      maxProtocolFeeBps: 300,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 1n,
    };
    await expect(
      vault.connect(taker).fillOpenQuote(baseOpen, await mm1.signTypedData(domain, OPEN_TYPES, baseOpen))
    ).to.be.revertedWithCustomError(vault, "ProtocolFeeExceedsMax");

    const validOpen = { ...baseOpen, maxProtocolFeeBps: 500 };
    await vault
      .connect(taker)
      .fillOpenQuote(validOpen, await mm1.signTypedData(domain, OPEN_TYPES, validOpen));
    expect(await vault.accruedProtocolFees()).to.equal(
      computeProtocolFee(validOpen.userPayAmount, 400)
    );

    const sid = computeSeriesId(ASSET_BTC_ID, 60000_00000000n, 62000_00000000n, expiry);
    expect(await vault.balanceOf(taker.address, computeDownTokenId(sid))).to.equal(
      ethers.parseUnits("60", 6)
    );
    expect(await vault.balanceOf(mm1.address, computeUpTokenId(sid))).to.equal(
      ethers.parseUnits("60", 6)
    );

    await vault.connect(admin).setProtocolFees(400, 50);

    const badClose = {
      taker: taker.address,
      maker: mm1.address,
      seriesId: sid,
      isUp: false,
      amount: ethers.parseUnits("30", 6),
      buybackAmount: ethers.parseUnits("20", 6),
      maxCloseFeeBps: 25,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 2n,
    };
    await expect(
      vault
        .connect(taker)
        .fillCloseQuote(badClose, await mm1.signTypedData(domain, CLOSE_TYPES, badClose))
    ).to.be.revertedWithCustomError(vault, "ProtocolFeeExceedsMax");

    // 1. Atomic merge close of 30 DOWN with mm1
    const closeMerge = { ...badClose, maxCloseFeeBps: 50 };
    const mm1MarginBefore = await vault.makerMargin(mm1.address);
    const takerUsdtBefore = await usdt.balanceOf(taker.address);
    const feesBefore = await vault.accruedProtocolFees();

    await expect(
      vault
        .connect(taker)
        .fillCloseQuote(closeMerge, await mm1.signTypedData(domain, CLOSE_TYPES, closeMerge))
    ).to.emit(vault, "TicketClosedEarly");

    const closeFee1 = (ethers.parseUnits("20", 6) * 50n) / 10_000n;
    expect((await usdt.balanceOf(taker.address)) - takerUsdtBefore).to.equal(
      ethers.parseUnits("20", 6) - closeFee1
    );
    expect((await vault.makerMargin(mm1.address)) - mm1MarginBefore).to.equal(
      ethers.parseUnits("10", 6)
    );
    expect((await vault.accruedProtocolFees()) - feesBefore).to.equal(closeFee1);

    // 2. External competing MM (mm2) takes over 10 DOWN for 8 USDT
    const closeTakeover = {
      taker: taker.address,
      maker: mm2.address,
      seriesId: sid,
      isUp: false,
      amount: ethers.parseUnits("10", 6),
      buybackAmount: ethers.parseUnits("8", 6),
      maxCloseFeeBps: 100,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 10n,
    };
    const mm2MarginBefore = await vault.makerMargin(mm2.address);
    await vault
      .connect(taker)
      .fillCloseQuote(closeTakeover, await mm2.signTypedData(domain, CLOSE_TYPES, closeTakeover));

    expect(mm2MarginBefore - (await vault.makerMargin(mm2.address))).to.equal(
      ethers.parseUnits("8", 6)
    );
    expect(await vault.balanceOf(mm2.address, computeDownTokenId(sid))).to.equal(
      ethers.parseUnits("10", 6)
    );

    // 3. Hybrid close: taker opens 20 DOWN with mm2, then closes 35 DOWN with mm1 (30 merged + 5 transferred)
    const openMore = {
      ...validOpen,
      maker: mm2.address,
      maxPayout: ethers.parseUnits("20", 6),
      userPayAmount: ethers.parseUnits("7", 6),
      nonce: 11n,
    };
    await vault
      .connect(taker)
      .fillOpenQuote(openMore, await mm2.signTypedData(domain, OPEN_TYPES, openMore));

    const closeHybrid = {
      taker: taker.address,
      maker: mm1.address,
      seriesId: sid,
      isUp: false,
      amount: ethers.parseUnits("35", 6),
      buybackAmount: ethers.parseUnits("33", 6),
      maxCloseFeeBps: 50,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 3n,
    };
    const mm1BeforeHybrid = await vault.makerMargin(mm1.address);
    await vault
      .connect(taker)
      .fillCloseQuote(closeHybrid, await mm1.signTypedData(domain, CLOSE_TYPES, closeHybrid));
    expect(mm1BeforeHybrid - (await vault.makerMargin(mm1.address))).to.equal(
      ethers.parseUnits("3", 6)
    );
    expect(await vault.balanceOf(mm1.address, computeDownTokenId(sid))).to.equal(
      ethers.parseUnits("5", 6)
    );
    expect(await vault.balanceOf(mm1.address, computeUpTokenId(sid))).to.equal(0n);

    await assertVaultSolvent(vault);
  });

  it("resists USDT freeze DoS for makers, sweeps floor-rounding dust to accruedProtocolFees, and supports redeemFor + aggregated batchRedeem via Atlas proof settlement", async function () {
    const {
      admin,
      mm1,
      taker,
      keeper,
      stranger,
      atlasSigner,
      usdt,
      usdtAddr,
      vault,
      oracle,
      domain,
    } = await deployFixture();
    const now = await time.latest();
    const expiry = next08Utc(now, 2);

    const q1 = {
      taker: taker.address,
      maker: mm1.address,
      assetId: ASSET_BTC_ID,
      isUp: true,
      lowerStrike: 100_00000000n,
      upperStrike: 103_00000000n,
      expiry,
      userPayAmount: ethers.parseUnits("20", 6),
      maxPayout: ethers.parseUnits("100", 6),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 1n,
    };
    await vault.connect(taker).fillOpenQuote(q1, await mm1.signTypedData(domain, OPEN_TYPES, q1));

    const q2 = {
      taker: taker.address,
      maker: mm1.address,
      assetId: ASSET_ETH_ID,
      isUp: true,
      lowerStrike: 1800_00000000n,
      upperStrike: 2000_00000000n,
      expiry,
      userPayAmount: ethers.parseUnits("15", 6),
      maxPayout: ethers.parseUnits("40", 6),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 2n,
    };
    await vault.connect(taker).fillOpenQuote(q2, await mm1.signTypedData(domain, OPEN_TYPES, q2));

    const sid1 = computeSeriesId(ASSET_BTC_ID, 100_00000000n, 103_00000000n, expiry);
    const sid2 = computeSeriesId(ASSET_ETH_ID, 1800_00000000n, 2000_00000000n, expiry);

    // Freeze mm1 on USDT -> taker & protocol operations remain unaffected
    await usdt.connect(admin).setFrozen(mm1.address, true);

    await expect(
      settleExpiryWithCustomAtlasProof({
        oracle,
        caller: keeper,
        signerPrivateKey: atlasSigner.privateKey,
        assetId: ASSET_BTC_ID,
        feedId: FEED_ID_BTC,
        expiry,
        price8: 101_00000000n,
      })
    ).to.be.revertedWithCustomError(oracle, "ExpiryNotReached");

    await time.increaseTo(expiry + 10);
    await settleExpiryWithCustomAtlasProof({
      oracle,
      caller: keeper,
      signerPrivateKey: atlasSigner.privateKey,
      assetId: ASSET_BTC_ID,
      feedId: FEED_ID_BTC,
      expiry,
      price8: 101_00000000n,
    });
    await settleExpiryWithCustomAtlasProof({
      oracle,
      caller: keeper,
      signerPrivateKey: atlasSigner.privateKey,
      assetId: ASSET_ETH_ID,
      feedId: FEED_ID_ETH,
      expiry,
      price8: 1900_00000000n,
    });

    await expect(
      settleExpiryWithCustomAtlasProof({
        oracle,
        caller: keeper,
        signerPrivateKey: atlasSigner.privateKey,
        assetId: ASSET_BTC_ID,
        feedId: FEED_ID_BTC,
        expiry,
        price8: 101_00000000n,
      })
    ).to.be.revertedWithCustomError(oracle, "AlreadySettled");

    // Batch redeem emits exactly ONE aggregated USDT Transfer event
    const takerBefore = await usdt.balanceOf(taker.address);
    const batchTx = await vault.connect(taker).batchRedeem([sid1, sid2]);
    const batchReceipt = await batchTx.wait();

    const transferTopic = usdt.interface.getEvent("Transfer").topicHash;
    const usdtTransfers = batchReceipt!.logs.filter(
      (l) => l.address.toLowerCase() === usdtAddr.toLowerCase() && l.topics[0] === transferTopic
    );
    expect(usdtTransfers.length).to.equal(1);

    const expectedSid1Up = 33_333_333n;
    const expectedSid2Up = 20_000_000n;
    expect((await usdt.balanceOf(taker.address)) - takerBefore).to.equal(
      expectedSid1Up + expectedSid2Up
    );

    // Permissionless redeemFor(mm1, sid) succeeds even while mm1 is frozen on USDT
    const mm1MarginBefore = await vault.makerMargin(mm1.address);
    const feesBeforeDust = await vault.accruedProtocolFees();

    await vault.connect(stranger).redeemFor(mm1.address, sid1);
    await vault.connect(stranger).redeemFor(mm1.address, sid2);

    const expectedSid1Down = 66_666_666n;
    const expectedSid2Down = 20_000_000n;
    expect((await vault.makerMargin(mm1.address)) - mm1MarginBefore).to.equal(
      expectedSid1Down + expectedSid2Down
    );
    expect((await vault.accruedProtocolFees()) - feesBeforeDust).to.equal(1n);

    expect(await vault.totalLockedUsdt()).to.equal(0n);
    await assertVaultSolvent(vault);
  });

  it("enforces Ownable2Step + pauser/feeCollector role separation, pause-exempt merge/withdraw/redeem, oracle swap, custom Phase-2 asset, and safe rescueToken", async function () {
    const {
      admin,
      mm1,
      taker,
      keeper,
      pauser,
      stranger,
      newAdmin,
      atlasSigner,
      usdt,
      vault,
      vaultAddr,
      domain,
    } = await deployFixture();
    const now = await time.latest();

    // 1. Lightweight role separation checks
    await expect(vault.connect(pauser).setProtocolFees(300, 0)).to.be.revertedWithCustomError(
      vault,
      "OwnableUnauthorizedAccount"
    );
    await expect(
      vault.connect(stranger).collectProtocolFees(stranger.address, 1n)
    ).to.be.revertedWithCustomError(vault, "Unauthorized");
    await expect(vault.connect(stranger).pause()).to.be.revertedWithCustomError(
      vault,
      "Unauthorized"
    );

    // 2. Register Phase-2 US equity asset NVDA with 20:00 UTC settlement offset
    const ASSET_NVDA = symbolToAssetId("NVDA");
    const FEED_NVDA = "0x00000999";
    const nvdaExpiry = nextUtcAtOffset(now, 2, 20 * 3600);
    const nvdaQuote = {
      taker: taker.address,
      maker: mm1.address,
      assetId: ASSET_NVDA,
      isUp: true,
      lowerStrike: 130_00000000n,
      upperStrike: 140_00000000n,
      expiry: nvdaExpiry,
      userPayAmount: ethers.parseUnits("20", 6),
      maxPayout: ethers.parseUnits("50", 6),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 500n,
    };
    const nvdaSig = await mm1.signTypedData(domain, OPEN_TYPES, nvdaQuote);

    await expect(
      vault.connect(taker).fillOpenQuote(nvdaQuote, nvdaSig)
    ).to.be.revertedWithCustomError(vault, "AssetNotEnabled");

    await vault.connect(admin).setAssetConfig(ASSET_NVDA, true, true, 20 * 3600, 86400);
    await vault.connect(taker).fillOpenQuote(nvdaQuote, nvdaSig);
    const nvdaSid = computeSeriesId(ASSET_NVDA, 130_00000000n, 140_00000000n, nvdaExpiry);

    const btcExpiry = next08Utc(now, 2);
    const btcQuote = {
      ...nvdaQuote,
      assetId: ASSET_BTC_ID,
      lowerStrike: 62000_00000000n,
      upperStrike: 64000_00000000n,
      expiry: btcExpiry,
      nonce: 501n,
    };
    await vault
      .connect(taker)
      .fillOpenQuote(btcQuote, await mm1.signTypedData(domain, OPEN_TYPES, btcQuote));
    const btcSid = computeSeriesId(ASSET_BTC_ID, 62000_00000000n, 64000_00000000n, btcExpiry);
    await vault
      .connect(taker)
      .safeTransferFrom(
        taker.address,
        mm1.address,
        computeUpTokenId(btcSid),
        ethers.parseUnits("10", 6),
        "0x"
      );

    // 3. Pause via pauser; pauser CANNOT unpause
    await vault.connect(pauser).pause();
    await expect(vault.connect(pauser).unpause()).to.be.revertedWithCustomError(
      vault,
      "OwnableUnauthorizedAccount"
    );

    const blockedQuote = { ...btcQuote, nonce: 502n };
    await expect(
      vault
        .connect(taker)
        .fillOpenQuote(blockedQuote, await mm1.signTypedData(domain, OPEN_TYPES, blockedQuote))
    ).to.be.revertedWithCustomError(vault, "EnforcedPause");

    await expect(
      vault.connect(mm1).depositMakerMargin(ethers.parseUnits("10", 6))
    ).to.be.revertedWithCustomError(vault, "EnforcedPause");

    // merge() & withdrawMakerMargin() work even while paused
    await vault.connect(mm1).merge(btcSid, ethers.parseUnits("10", 6));

    await vault.connect(admin).setWhitelistedMaker(mm1.address, false);
    const mm1UsdtBefore = await usdt.balanceOf(mm1.address);
    await vault.connect(mm1).withdrawMakerMargin(ethers.parseUnits("100", 6));
    expect((await usdt.balanceOf(mm1.address)) - mm1UsdtBefore).to.equal(
      ethers.parseUnits("100", 6)
    );
    await vault.connect(admin).setWhitelistedMaker(mm1.address, true);

    // 4. Swap settlement oracle via setSettlementOracle without redeploying Vault
    const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
    const newOracle = await Oracle.deploy(admin.address, atlasSigner.address);
    await newOracle.connect(admin).setAssetFeedId(ASSET_NVDA, FEED_NVDA);
    await vault.connect(admin).setSettlementOracle(await newOracle.getAddress());

    await time.increaseTo(nvdaExpiry + 10);
    await settleExpiryWithCustomAtlasProof({
      oracle: newOracle,
      caller: keeper,
      signerPrivateKey: atlasSigner.privateKey,
      assetId: ASSET_NVDA,
      feedId: FEED_NVDA,
      expiry: nvdaExpiry,
      price8: 135_00000000n,
    });

    // Redeem works even while paused
    const takerBeforeRedeem = await usdt.balanceOf(taker.address);
    await vault.connect(taker).redeem(nvdaSid);
    expect((await usdt.balanceOf(taker.address)) - takerBeforeRedeem).to.equal(
      ethers.parseUnits("25", 6)
    );

    await vault.connect(admin).unpause();

    // 5. Safe rescueToken
    await expect(
      vault.connect(admin).rescueToken(await usdt.getAddress(), admin.address, 1n)
    ).to.be.revertedWithCustomError(vault, "InsufficientSurplus");

    const surplusAmt = ethers.parseUnits("77", 6);
    await usdt.mint(vaultAddr, surplusAmt);
    await expect(
      vault.connect(admin).rescueToken(await usdt.getAddress(), admin.address, surplusAmt + 1n)
    ).to.be.revertedWithCustomError(vault, "InsufficientSurplus");
    await vault.connect(admin).rescueToken(await usdt.getAddress(), admin.address, surplusAmt);

    const MockERC20 = await ethers.getContractFactory("MockUSDT");
    const otherToken = await MockERC20.deploy(admin.address);
    await otherToken.mint(vaultAddr, ethers.parseUnits("50", 6));
    await vault
      .connect(admin)
      .rescueToken(await otherToken.getAddress(), admin.address, ethers.parseUnits("50", 6));
    expect(await otherToken.balanceOf(admin.address)).to.equal(ethers.parseUnits("50", 6));

    // 6. Ownable2Step 2-step ownership transfer
    await vault.connect(admin).transferOwnership(newAdmin.address);
    await vault.connect(newAdmin).acceptOwnership();
    expect(await vault.owner()).to.equal(newAdmin.address);

    await assertVaultSolvent(vault);
  });

  it("handles edge cases: cancelNonce, insufficient makerMargin, close window elapsed, ERC-1155 transfer active index, lens pagination, and worthless OTM expiry cleanup", async function () {
    const {
      mm1,
      taker,
      keeper,
      stranger,
      atlasSigner,
      usdt,
      vault,
      lens,
      vaultAddr,
      oracle,
      domain,
    } = await deployFixture();
    const now = await time.latest();
    const expiry = next08Utc(now, 2);

    const cancelledQuote = {
      taker: taker.address,
      maker: mm1.address,
      assetId: ASSET_BTC_ID,
      isUp: true,
      lowerStrike: 62000_00000000n,
      upperStrike: 64000_00000000n,
      expiry,
      userPayAmount: ethers.parseUnits("20", 6),
      maxPayout: ethers.parseUnits("50", 6),
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 777n,
    };
    const cancelledSig = await mm1.signTypedData(domain, OPEN_TYPES, cancelledQuote);
    await vault.connect(mm1).cancelNonce(777n);
    await expect(
      vault.connect(taker).fillOpenQuote(cancelledQuote, cancelledSig)
    ).to.be.revertedWithCustomError(vault, "NonceAlreadyUsed");

    const hugeQuote = {
      ...cancelledQuote,
      maxPayout: ethers.parseUnits("999999", 6),
      nonce: 778n,
    };
    const hugeSig = await mm1.signTypedData(domain, OPEN_TYPES, hugeQuote);
    await expect(
      vault.connect(taker).fillOpenQuote(hugeQuote, hugeSig)
    ).to.be.revertedWithCustomError(vault, "InsufficientMakerMargin");

    const q1 = { ...cancelledQuote, nonce: 779n };
    await vault.connect(taker).fillOpenQuote(q1, await mm1.signTypedData(domain, OPEN_TYPES, q1));

    const q2 = {
      ...cancelledQuote,
      assetId: ASSET_ETH_ID,
      isUp: false,
      lowerStrike: 1800_00000000n,
      upperStrike: 2000_00000000n,
      nonce: 780n,
    };
    await vault.connect(taker).fillOpenQuote(q2, await mm1.signTypedData(domain, OPEN_TYPES, q2));

    const sid1 = computeSeriesId(ASSET_BTC_ID, 62000_00000000n, 64000_00000000n, expiry);
    const sid2 = computeSeriesId(ASSET_ETH_ID, 1800_00000000n, 2000_00000000n, expiry);

    const [p1, tot1] = await lens.getUserActivePositions(vaultAddr, taker.address, 0, 1);
    const [p2, tot2] = await lens.getUserActivePositions(vaultAddr, taker.address, 1, 1);
    expect(tot1).to.equal(2n);
    expect(tot2).to.equal(2n);
    expect(p1.length).to.equal(1);
    expect(p2.length).to.equal(1);
    expect(p1[0].tokenId).to.not.equal(p2[0].tokenId);

    // Direct ERC-1155 transfer of DOWN token moves active slot to stranger
    await vault
      .connect(taker)
      .safeTransferFrom(
        taker.address,
        stranger.address,
        computeDownTokenId(sid2),
        ethers.parseUnits("50", 6),
        "0x"
      );
    expect(await vault.getUserActiveTokenCount(taker.address)).to.equal(1n);
    expect(await vault.getUserActiveTokenCount(stranger.address)).to.equal(1n);

    // Close window elapsed (< 5 min before expiry)
    await time.increaseTo(expiry - 120);
    const lateClose = {
      taker: taker.address,
      maker: mm1.address,
      seriesId: sid1,
      isUp: true,
      amount: ethers.parseUnits("50", 6),
      buybackAmount: ethers.parseUnits("25", 6),
      maxCloseFeeBps: 0,
      makerEpoch: 0n,
      validUntil: expiry,
      nonce: 781n,
    };
    await expect(
      vault
        .connect(taker)
        .fillCloseQuote(lateClose, await mm1.signTypedData(domain, CLOSE_TYPES, lateClose))
    ).to.be.revertedWithCustomError(vault, "CloseWindowElapsed");

    // Worthless OTM expiry cleanup
    await time.increaseTo(expiry + 10);
    await settleExpiryWithCustomAtlasProof({
      oracle,
      caller: keeper,
      signerPrivateKey: atlasSigner.privateKey,
      assetId: ASSET_BTC_ID,
      feedId: FEED_ID_BTC,
      expiry,
      price8: 60000_00000000n,
    });
    await settleExpiryWithCustomAtlasProof({
      oracle,
      caller: keeper,
      signerPrivateKey: atlasSigner.privateKey,
      assetId: ASSET_ETH_ID,
      feedId: FEED_ID_ETH,
      expiry,
      price8: 2200_00000000n,
    });

    const takerUsdtBefore = await usdt.balanceOf(taker.address);
    await vault.connect(taker).redeem(sid1);
    expect(await usdt.balanceOf(taker.address)).to.equal(takerUsdtBefore);
    expect(await vault.getUserActiveTokenCount(taker.address)).to.equal(0n);

    await vault.connect(stranger).redeem(sid2);
    expect(await vault.getUserActiveTokenCount(stranger.address)).to.equal(0n);

    const mm1Before = await vault.makerMargin(mm1.address);
    await vault.connect(mm1).batchRedeem([sid1, sid2]);
    expect((await vault.makerMargin(mm1.address)) - mm1Before).to.equal(
      ethers.parseUnits("100", 6)
    );
    expect(await vault.totalLockedUsdt()).to.equal(0n);

    // PayoffVaultLens getAllSeries pagination check
    const [seriesPage, seriesTotal] = await lens.getAllSeries(vaultAddr, 0, 10);
    expect(seriesTotal).to.equal(2n);
    expect(seriesPage.length).to.equal(2);

    await assertVaultSolvent(vault);
  });

  it("handles previewPayout at type(uint256).max without overflow and EIP-1271 wallet as both maker & taker", async function () {
    const {
      admin,
      mm2,
      taker,
      keeper,
      hotSigner,
      stranger,
      atlasSigner,
      usdt,
      vault,
      vaultAddr,
      oracle,
      domain,
    } = await deployFixture();
    const now = await time.latest();
    const expiry = next08Utc(now, 2);

    const payAmt = ethers.parseUnits("20", 6);
    const maxPayout = ethers.parseUnits("50", 6);

    const MockWallet = await ethers.getContractFactory("MockERC1271Wallet");
    const smartMaker = await MockWallet.deploy(stranger.address);
    const smartMakerAddr = await smartMaker.getAddress();
    const smartTaker = await MockWallet.deploy(hotSigner.address);
    const smartTakerAddr = await smartTaker.getAddress();

    await vault.connect(admin).setWhitelistedMaker(smartMakerAddr, true);
    const smFund = ethers.parseUnits("10000", 6);
    await usdt.mint(smartMakerAddr, smFund);
    await smartMaker.connect(stranger).execute(
      await usdt.getAddress(),
      usdt.interface.encodeFunctionData("approve", [vaultAddr, smFund])
    );
    await smartMaker.connect(stranger).execute(
      vaultAddr,
      vault.interface.encodeFunctionData("depositMakerMargin", [smFund])
    );
    await smartMaker.connect(stranger).execute(
      vaultAddr,
      vault.interface.encodeFunctionData("setMakerSigner", [hotSigner.address, true])
    );

    await usdt.mint(smartTakerAddr, ethers.parseUnits("500", 6));
    await smartTaker.connect(hotSigner).execute(
      await usdt.getAddress(),
      usdt.interface.encodeFunctionData("approve", [vaultAddr, ethers.MaxUint256])
    );

    const smOpen1 = {
      taker: smartTakerAddr,
      maker: smartMakerAddr,
      assetId: ASSET_BTC_ID,
      isUp: true,
      lowerStrike: 100_00000000n,
      upperStrike: 103_00000000n,
      expiry,
      userPayAmount: payAmt,
      maxPayout,
      maxProtocolFeeBps: 400,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 9002n,
    };
    const hotMakerSig = await hotSigner.signTypedData(domain, OPEN_TYPES, smOpen1);
    await smartTaker.connect(hotSigner).execute(
      vaultAddr,
      vault.interface.encodeFunctionData("fillOpenQuote", [smOpen1, hotMakerSig])
    );
    const sid = computeSeriesId(ASSET_BTC_ID, 100_00000000n, 103_00000000n, expiry);
    expect(await vault.balanceOf(smartTakerAddr, computeUpTokenId(sid))).to.equal(maxPayout);
    expect(await vault.balanceOf(smartMakerAddr, computeDownTokenId(sid))).to.equal(maxPayout);

    const takerOpen = {
      ...smOpen1,
      taker: taker.address,
      maker: mm2.address,
      nonce: 9003n,
    };
    await vault
      .connect(taker)
      .fillOpenQuote(takerOpen, await mm2.signTypedData(domain, OPEN_TYPES, takerOpen));

    const smCloseMerge = {
      taker: taker.address,
      maker: smartMakerAddr,
      seriesId: sid,
      isUp: true,
      amount: ethers.parseUnits("30", 6),
      buybackAmount: ethers.parseUnits("15", 6),
      maxCloseFeeBps: 0,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 9004n,
    };
    await vault
      .connect(taker)
      .fillCloseQuote(smCloseMerge, await stranger.signTypedData(domain, CLOSE_TYPES, smCloseMerge));

    const smClose2 = {
      ...smCloseMerge,
      amount: ethers.parseUnits("20", 6),
      buybackAmount: ethers.parseUnits("10", 6),
      nonce: 9005n,
    };
    await vault
      .connect(taker)
      .fillCloseQuote(smClose2, await stranger.signTypedData(domain, CLOSE_TYPES, smClose2));
    expect(await vault.balanceOf(smartMakerAddr, computeDownTokenId(sid))).to.equal(0n);

    // External takeover into smartMaker (triggers onERC1155Received)
    const smTakeover = {
      taker: smartTakerAddr,
      maker: smartMakerAddr,
      seriesId: sid,
      isUp: true,
      amount: ethers.parseUnits("10", 6),
      buybackAmount: ethers.parseUnits("6", 6),
      maxCloseFeeBps: 0,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 9006n,
    };
    const smTakeoverSig = await stranger.signTypedData(domain, CLOSE_TYPES, smTakeover);
    await smartTaker.connect(hotSigner).execute(
      vaultAddr,
      vault.interface.encodeFunctionData("fillCloseQuote", [smTakeover, smTakeoverSig])
    );
    expect(await vault.balanceOf(smartMakerAddr, computeUpTokenId(sid))).to.equal(
      ethers.parseUnits("10", 6)
    );

    await time.increaseTo(expiry + 10);
    await settleExpiryWithCustomAtlasProof({
      oracle,
      caller: keeper,
      signerPrivateKey: atlasSigner.privateKey,
      assetId: ASSET_BTC_ID,
      feedId: FEED_ID_BTC,
      expiry,
      price8: 101_00000000n,
    });

    // 512-bit Math.mulDiv previewPayout at type(uint256).max
    const [maxUpPay, maxDownPay] = await vault.previewPayout(
      sid,
      ethers.MaxUint256,
      ethers.MaxUint256
    );
    expect(maxUpPay).to.equal(ethers.MaxUint256 / 3n);
    expect(maxDownPay).to.equal((ethers.MaxUint256 * 2n) / 3n);
    expect(maxUpPay + maxDownPay).to.be.lessThanOrEqual(ethers.MaxUint256);

    await smartMaker.connect(stranger).execute(
      vaultAddr,
      vault.interface.encodeFunctionData("redeem", [sid])
    );
    await smartTaker.connect(hotSigner).execute(
      vaultAddr,
      vault.interface.encodeFunctionData("redeem", [sid])
    );
    await vault.connect(taker).redeemFor(mm2.address, sid);

    expect(await vault.totalLockedUsdt()).to.equal(0n);
    const [bal, locked, margin, fees] = await vault.vaultHealth();
    expect(bal).to.equal(locked + margin + fees);
  });

  it("maintains strict 1:1 solvency and supply invariants across multi-actor transfers, self-transfers, partial closes, merges, and dust sweeps", async function () {
    const {
      mm1,
      mm2,
      taker,
      hotSigner,
      stranger,
      keeper,
      feeCollector,
      atlasSigner,
      usdt,
      vault,
      vaultAddr,
      oracle,
      domain,
    } = await deployFixture();
    const alice = taker;
    const bob = hotSigner;
    const charlie = stranger;
    await usdt.mint(bob.address, ethers.parseUnits("5000", 6));
    await usdt.mint(charlie.address, ethers.parseUnits("5000", 6));
    await usdt.connect(bob).approve(vaultAddr, ethers.MaxUint256);
    await usdt.connect(charlie).approve(vaultAddr, ethers.MaxUint256);

    const now = await time.latest();
    const expiry = next08Utc(now, 2);
    const sid = computeSeriesId(ASSET_BTC_ID, 100_00000000n, 107_00000000n, expiry); // prime width 7

    const assertStrictInvariants = async (expectEqualSupplies: boolean) => {
      const [bal, locked, margin, fees, solvent] = await vault.vaultHealth();
      expect(solvent).to.equal(true);
      expect(bal).to.equal(locked + margin + fees);
      const s = await vault.seriesById(sid);
      if (expectEqualSupplies) {
        expect(s.upSupply).to.equal(s.downSupply);
        expect(s.lockedUsdt).to.equal(s.upSupply);
      }
    };

    const opens = [
      { actor: alice, maker: mm1, isUp: true, pay: "25", max: "70", nonce: 1n },
      { actor: bob, maker: mm2, isUp: false, pay: "15", max: "40", nonce: 2n },
      { actor: charlie, maker: mm2, isUp: true, pay: "12", max: "30", nonce: 3n },
    ];
    for (const o of opens) {
      const q = {
        taker: o.actor.address,
        maker: o.maker.address,
        assetId: ASSET_BTC_ID,
        isUp: o.isUp,
        lowerStrike: 100_00000000n,
        upperStrike: 107_00000000n,
        expiry,
        userPayAmount: ethers.parseUnits(o.pay, 6),
        maxPayout: ethers.parseUnits(o.max, 6),
        maxProtocolFeeBps: 400,
        makerEpoch: 0n,
        validUntil: now + 300,
        nonce: o.nonce,
      };
      await vault.connect(o.actor).fillOpenQuote(q, await o.maker.signTypedData(domain, OPEN_TYPES, q));
      await assertStrictInvariants(true);
    }

    const upId = computeUpTokenId(sid);
    await vault.connect(alice).safeTransferFrom(alice.address, bob.address, upId, ethers.parseUnits("17", 6), "0x");
    await vault.connect(alice).safeTransferFrom(alice.address, alice.address, upId, ethers.parseUnits("5", 6), "0x");
    expect(await vault.getUserActiveTokenCount(alice.address)).to.equal(1n);
    expect(await vault.getUserActiveTokenCount(bob.address)).to.equal(2n);
    await assertStrictInvariants(true);

    await vault.connect(bob).merge(sid, ethers.parseUnits("17", 6));
    expect(await vault.getUserActiveTokenCount(bob.address)).to.equal(1n);
    await assertStrictInvariants(true);

    await vault.connect(mm2).merge(sid, ethers.parseUnits("25", 6));
    await assertStrictInvariants(true);

    const c1 = {
      taker: alice.address,
      maker: mm1.address,
      seriesId: sid,
      isUp: true,
      amount: ethers.parseUnits("20", 6),
      buybackAmount: ethers.parseUnits("9", 6),
      maxCloseFeeBps: 0,
      makerEpoch: 0n,
      validUntil: now + 300,
      nonce: 10n,
    };
    await vault.connect(alice).fillCloseQuote(c1, await mm1.signTypedData(domain, CLOSE_TYPES, c1));
    await assertStrictInvariants(true);

    const c2 = {
      ...c1,
      maker: mm2.address,
      amount: ethers.parseUnits("10", 6),
      buybackAmount: ethers.parseUnits("4", 6),
      nonce: 11n,
    };
    await vault.connect(alice).fillCloseQuote(c2, await mm2.signTypedData(domain, CLOSE_TYPES, c2));
    await assertStrictInvariants(true);

    await time.increaseTo(expiry + 10);
    await settleExpiryWithCustomAtlasProof({
      oracle,
      caller: keeper,
      signerPrivateKey: atlasSigner.privateKey,
      assetId: ASSET_BTC_ID,
      feedId: FEED_ID_BTC,
      expiry,
      price8: 103_00000000n,
    });

    for (const acct of [alice, bob, charlie, mm1, mm2]) {
      const hasUp = (await vault.balanceOf(acct.address, upId)) > 0n;
      const hasDown = (await vault.balanceOf(acct.address, computeDownTokenId(sid))) > 0n;
      if (hasUp || hasDown) {
        await vault.connect(charlie).redeemFor(acct.address, sid);
        await assertStrictInvariants(false);
      }
    }

    expect(await vault.totalLockedUsdt()).to.equal(0n);
    const fees = await vault.accruedProtocolFees();
    expect(fees).to.be.greaterThan(0n);
    await vault.connect(feeCollector).collectProtocolFees(feeCollector.address, fees);

    await vault.connect(mm1).withdrawMakerMargin(await vault.makerMargin(mm1.address));
    await vault.connect(mm2).withdrawMakerMargin(await vault.makerMargin(mm2.address));
    expect(await usdt.balanceOf(vaultAddr)).to.equal(0n);
    await assertStrictInvariants(false);
  });
});
