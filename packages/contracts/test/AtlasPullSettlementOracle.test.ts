import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  ATLAS_MAGIC_MARKER,
  ATLAS_OFFICIAL_SIGNER,
  FEED_ID_BTC,
  FEED_ID_ETH,
  buildSignedAtlasProof,
  buildSignedAtlasTwapProofs,
  buildTwapSampleTimestamps,
  encodeVerifyAtlasFeedProofCalldata,
  encodeVerifyLatestAtlasPriceCalldata,
} from "./helpers/atlasProof";

const ASSET_BTC = ethers.keccak256(ethers.toUtf8Bytes("BTC"));
const ASSET_ETH = ethers.keccak256(ethers.toUtf8Bytes("ETH"));

/**
 * Real production signed Atlas Oracle fixtures captured from
 * https://api.atlasoracle.io/report/v1/price/latest and /v1/price/history.
 * Signed by Atlas Oracle's official production signer:
 * 0x59eD4701224fD9e2a85Ef2946c2ab828C1dDC600 (magic marker 0x7096).
 * Contains only public signed market data — zero API keys or secrets.
 */
const PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE = {
  payload: "0x000002720c6bed79993fee76157800006b06958001",
  signature:
    "0xc9d5cbbd66d4a0ed85b03d9ec0a4f8210e7f7485fba1c64e8cdc1d49cd1877fa20da5f67348fe118a0c997a7d0082f33ff3e713b6d366df16928aad87e1945d71c",
  magicMarker: "0x7096",
  timestamp: 1795593600, // 2026-11-25T08:00:00Z
  expectedPrice18: 58659311287081698203000n,
  expectedPrice8: 5865931128708n, // $58,659.31128708
  feedId: FEED_ID_BTC,
};

const PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE = {
  payload:
    "0x000002720c71fb9cd941997aa6c800006b06be500000027800590612d7521b06abd800006b06be5002",
  signature:
    "0x87d845fecfada85927079a53ca58f3867ffc859237a856b60a52c7c763ba5a1f3aad49710f63d9e2cbd57630f3a43d38c170cf83f05ad4bb242fbb0ea34220d91b",
  magicMarker: "0x7096",
  timestamp: 1795604048,
  btc: {
    expectedPrice18: 58771010479840579725000n,
    expectedPrice8: 5877101047984n, // $58,771.01047984
    feedId: FEED_ID_BTC,
  },
  eth: {
    expectedPrice18: 1642197871421599165400n,
    expectedPrice8: 164219787142n, // $1,642.19787142
    feedId: FEED_ID_ETH,
  },
};

describe("AtlasPullSettlementOracle (30m TWAP & Dispute Controls) & MockUSDT", function () {
  async function deployWithCustomSigner() {
    const [admin, pauser, stranger, newAdmin] = await ethers.getSigners();
    const customSigner = ethers.Wallet.createRandom();
    const rogueSigner = ethers.Wallet.createRandom();

    const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
    const oracle = await Oracle.deploy(admin.address, customSigner.address);
    await oracle.connect(admin).setPauser(pauser.address);
    const oracleAddr = await oracle.getAddress();

    return {
      admin,
      pauser,
      stranger,
      newAdmin,
      customSigner,
      rogueSigner,
      oracle,
      oracleAddr,
    };
  }

  describe("Production Atlas Official Signer Verification (0x59eD...DC600)", function () {
    it("verifies real production Atlas /v1/price/history & multi-feed payloads via verifyAtlasFeedProof and 1-sample TWAP mode", async function () {
      const [admin, stranger] = await ethers.getSigners();
      const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
      const oracle = await Oracle.deploy(admin.address, ATLAS_OFFICIAL_SIGNER);
      const oracleAddr = await oracle.getAddress();

      const latest = await time.latest();
      if (latest < PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp + 120) {
        await time.increaseTo(PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp + 120);
      }

      // 1. Direct eth_call verification of official BTC historical fixture via verifyAtlasFeedProof
      const historyExtraData = ethers.concat([
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.payload,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.signature,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.magicMarker,
      ]);
      const rawHist = await ethers.provider.call({
        to: oracleAddr,
        data: encodeVerifyAtlasFeedProofCalldata(oracle.interface, FEED_ID_BTC, historyExtraData),
      });
      const [histPrice18, histTs] = oracle.interface.decodeFunctionResult(
        "verifyAtlasFeedProof",
        rawHist
      );
      expect(histPrice18).to.equal(PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.expectedPrice18);
      expect(histTs).to.equal(BigInt(PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp));

      // 2. Verify multi-feed official payload decodes both BTC (#626) and ETH (#632)
      const multiExtraData = ethers.concat([
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.payload,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.signature,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.magicMarker,
      ]);
      for (const [feedId, exp] of [
        [FEED_ID_BTC, PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.btc.expectedPrice18],
        [FEED_ID_ETH, PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.eth.expectedPrice18],
      ] as const) {
        const raw = await ethers.provider.call({
          to: oracleAddr,
          data: encodeVerifyAtlasFeedProofCalldata(oracle.interface, feedId, multiExtraData),
        });
        const [p18, ts] = oracle.interface.decodeFunctionResult("verifyAtlasFeedProof", raw);
        expect(p18).to.equal(exp);
        expect(ts).to.equal(BigInt(PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp));
      }

      // 3. Single-sample TWAP config mode settles official historical fixture permissionlessly
      await oracle.connect(admin).setTwapConfig(1, 60, 60, 900, 10);
      await expect(
        oracle
          .connect(stranger)
          .settleWithAtlasTwap(
            ASSET_BTC,
            PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp,
            [historyExtraData]
          )
      )
        .to.emit(oracle, "ExpirySettled")
        .withArgs(
          ASSET_BTC,
          PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp,
          PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.expectedPrice8,
          stranger.address,
          FEED_ID_BTC,
          PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp,
          PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp,
          1
        );

      const [price, settled] = await oracle.getSettlementPrice(
        ASSET_BTC,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp
      );
      expect(settled).to.equal(true);
      expect(price).to.equal(PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.expectedPrice8);
    });
  });

  describe("Deterministic 30-Point 1-Minute Equal-Weight TWAP Settlement", function () {
    it("computes exact 30-point equal-weight arithmetic mean, enforces settlementDelay, 0s exact pinning, and +-10s fallback", async function () {
      const { stranger, customSigner, oracle } = await deployWithCustomSigner();

      const now = await time.latest();
      const expiry = now + 3600;

      // Verify on-chain deterministic schedule [expiry - 29m .. expiry]
      const onChainSchedule = await oracle.getTwapSampleTimestamps(expiry);
      const expectedSchedule = buildTwapSampleTimestamps(expiry, 30, 60);
      expect(onChainSchedule.length).to.equal(30);
      expect(onChainSchedule[0]).to.equal(BigInt(expiry - 29 * 60));
      expect(onChainSchedule[29]).to.equal(BigInt(expiry));
      expect(onChainSchedule.map((v) => v)).to.deep.equal(expectedSchedule);

      // 30 distinct prices trending across the 30-minute window (pure equal-weight mean, no trimming)
      const prices18: bigint[] = [];
      for (let i = 0; i < 30; i++) {
        // $65,000 + $10 * i + fractional dust to test single-division scaling
        prices18.push((65_000n + BigInt(i) * 10n) * 10n ** 18n + 3333333333n * BigInt(i + 1));
      }
      const { extraDatas, expectedPrice8 } = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_BTC,
        expiry,
        prices18,
      });

      // 1. Pre-expiry reverts with ExpiryNotReached
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, extraDatas)
      ).to.be.revertedWithCustomError(oracle, "ExpiryNotReached");

      // 2. Inside 60s settlementDelay reverts with SettlementDelayNotElapsed
      await time.increaseTo(expiry + 30);
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, extraDatas)
      ).to.be.revertedWithCustomError(oracle, "SettlementDelayNotElapsed");

      // 3. Past 60s delay, still within 15m exactMatchGracePeriod: 1-second offset MUST revert!
      await time.increaseTo(expiry + 65);
      const oneSecOff = Array(30).fill(0);
      oneSecOff[15] = 1;
      const offByOneProofs = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_BTC,
        expiry,
        prices18,
        timestampOffsets: oneSecOff,
      });
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, offByOneProofs.extraDatas)
      )
        .to.be.revertedWithCustomError(oracle, "SampleTimestampMismatch")
        .withArgs(15, expectedSchedule[15]! + 1n, expectedSchedule[15]!, 0);

      // 4. Exact 30-point submission succeeds permissionlessly in 1 atomic tx
      const tx = await oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, extraDatas);
      await expect(tx)
        .to.emit(oracle, "ExpirySettled")
        .withArgs(
          ASSET_BTC,
          expiry,
          expectedPrice8,
          stranger.address,
          FEED_ID_BTC,
          expectedSchedule[0],
          expectedSchedule[29],
          30
        );

      const receipt = await tx.wait();
      expect(receipt!.gasUsed).to.be.lessThan(450_000n);

      const [settledPrice, settled] = await oracle.getSettlementPrice(ASSET_BTC, expiry);
      expect(settled).to.equal(true);
      expect(settledPrice).to.equal(expectedPrice8);

      const meta = await oracle.getSettlementMeta(ASSET_BTC, expiry);
      expect(meta.feedId).to.equal(FEED_ID_BTC);
      expect(meta.windowStartTimestamp).to.equal(expectedSchedule[0]);
      expect(meta.windowEndTimestamp).to.equal(expectedSchedule[29]);
      expect(meta.submitter).to.equal(stranger.address);
      expect(meta.sampleCount).to.equal(30n);
      expect(meta.isManualOverride).to.equal(false);
      expect(meta.overrideReason).to.equal("");

      // 5. Duplicate settlement reverts with AlreadySettled
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, extraDatas)
      ).to.be.revertedWithCustomError(oracle, "AlreadySettled");

      // 6. After 15m exactMatchGracePeriod: +-10s fallback tolerance works on ETH, +-11s reverts
      await time.increaseTo(expiry + 901);
      const ethPrices = Array.from({ length: 30 }, (_, i) => (2000n + BigInt(i)) * 10n ** 18n);
      const tooFarOffsets = Array(30).fill(0);
      tooFarOffsets[5] = -11;
      const tooFarEth = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_ETH,
        expiry,
        prices18: ethPrices,
        timestampOffsets: tooFarOffsets,
      });
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_ETH, expiry, tooFarEth.extraDatas)
      )
        .to.be.revertedWithCustomError(oracle, "SampleTimestampMismatch")
        .withArgs(5, expectedSchedule[5]! - 11n, expectedSchedule[5]!, 10);

      const fallbackOffsets = Array(30).fill(0);
      fallbackOffsets[0] = -10;
      fallbackOffsets[29] = 10;
      const fallbackEth = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_ETH,
        expiry,
        prices18: ethPrices,
        timestampOffsets: fallbackOffsets,
      });
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_ETH, expiry, fallbackEth.extraDatas)
      ).to.emit(oracle, "ExpirySettled");
    });

    it("rejects wrong proof count, short proof, zero price sample, rogue signer, tampered payload, wrong feed, and bad marker", async function () {
      const { admin, stranger, customSigner, rogueSigner, oracle } =
        await deployWithCustomSigner();

      const now = await time.latest();
      const expiry = now - 120;
      const basePrices = Array(30).fill(61_000n * 10n ** 18n);
      const valid = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_BTC,
        expiry,
        prices18: basePrices,
      });

      // Wrong proof count
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, valid.extraDatas.slice(0, 29))
      )
        .to.be.revertedWithCustomError(oracle, "InvalidProofCount")
        .withArgs(29, 30);

      // Short proof (< 88 bytes)
      const shortArr = [...valid.extraDatas];
      shortArr[3] = "0x1234";
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, shortArr)
      )
        .to.be.revertedWithCustomError(oracle, "InvalidProofLength")
        .withArgs(3, 2);

      // Single zero-price sample inside the 30-point window must revert
      const zeroPriceArr = [...basePrices];
      zeroPriceArr[12] = 0n;
      const zeroProofs = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_BTC,
        expiry,
        prices18: zeroPriceArr,
      });
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, zeroProofs.extraDatas)
      ).to.be.revertedWithCustomError(oracle, "InvalidPrice");

      // Rogue signer on proof #7 bubbles up UnauthorizedSigner
      const rogueArr = [...valid.extraDatas];
      const rogueSample = buildSignedAtlasProof(rogueSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18: 61_000n * 10n ** 18n, timestamp: valid.timestamps[7]! },
      ]);
      rogueArr[7] = rogueSample.extraData;
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, rogueArr)
      ).to.be.revertedWithCustomError(oracle, "UnauthorizedSigner");

      // Tampered payload byte bubbles up UnauthorizedSigner
      const tamperedArr = [...valid.extraDatas];
      const bytes = ethers.getBytes(tamperedArr[2]!);
      bytes[6] ^= 0xff;
      tamperedArr[2] = ethers.hexlify(bytes);
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, tamperedArr)
      ).to.be.revertedWithCustomError(oracle, "UnauthorizedSigner");

      // Wrong feedId on proof #4 bubbles up UnmatchedFeedID
      const wrongFeedArr = [...valid.extraDatas];
      wrongFeedArr[4] = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_ETH, price18: 2000n * 10n ** 18n, timestamp: valid.timestamps[4]! },
      ]).extraData;
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, wrongFeedArr)
      )
        .to.be.revertedWithCustomError(oracle, "UnmatchedFeedID")
        .withArgs(FEED_ID_BTC);

      // Bad magic marker on proof #0 bubbles up InvalidMarker
      const badMarkerArr = [...valid.extraDatas];
      badMarkerArr[0] = buildSignedAtlasProof(
        customSigner.privateKey,
        [{ feedId: FEED_ID_BTC, price18: 61_000n * 10n ** 18n, timestamp: valid.timestamps[0]! }],
        "0xdead"
      ).extraData;
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, badMarkerArr)
      ).to.be.revertedWithCustomError(oracle, "InvalidMarker");

      // Global pause blocks TWAP settlement
      await oracle.connect(admin).setSettlementPaused(true);
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, valid.extraDatas)
      ).to.be.revertedWithCustomError(oracle, "SettlementPaused");
      await oracle.connect(admin).setSettlementPaused(false);
    });
  });

  describe("Role-Separated Dispute Freeze (pauser) & Guarded Emergency Manual Settlement", function () {
    it("allows pauser to freeze before expiry, blocks pauser from unpausing/manual settling, and enforces all 4 guardrails on emergencyManualSettle", async function () {
      const { admin, pauser, stranger, customSigner, oracle } = await deployWithCustomSigner();

      const now = await time.latest();
      const expiry = now + 600; // 10 minutes before expiry
      const manualPrice8 = 64_250_00000000n;
      const auditReason = "Atlas 30m avg ConsensusScore 0.28 < 0.40; settled via fallback index";

      // 1. Stranger cannot pause
      await expect(
        oracle.connect(stranger).pauseExpiry(ASSET_BTC, expiry)
      ).to.be.revertedWithCustomError(oracle, "Unauthorized");

      // 2. Owner cannot emergency-settle BEFORE expiry or while unpaused
      await expect(
        oracle.connect(admin).emergencyManualSettle(ASSET_BTC, expiry, manualPrice8, auditReason)
      ).to.be.revertedWithCustomError(oracle, "ExpiryNotReached");

      // 3. Pauser freezes disputed expiry BEFORE expiry to prevent front-running
      await expect(oracle.connect(pauser).pauseExpiry(ASSET_BTC, expiry))
        .to.emit(oracle, "ExpirySettlementPausedUpdated")
        .withArgs(ASSET_BTC, expiry, true, pauser.address);
      expect(await oracle.isExpiryPaused(ASSET_BTC, expiry)).to.equal(true);

      // 4. Pauser CANNOT unpause and CANNOT call emergencyManualSettle
      await expect(
        oracle.connect(pauser).unpauseExpiry(ASSET_BTC, expiry)
      ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");
      await expect(
        oracle.connect(pauser).emergencyManualSettle(ASSET_BTC, expiry, manualPrice8, auditReason)
      ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");

      // 5. Even after expiry + settlementDelay, permissionless TWAP submission is blocked while paused
      await time.increaseTo(expiry + 120);
      const { extraDatas } = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_BTC,
        expiry,
        prices18: 64_000n * 10n ** 18n,
      });
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BTC, expiry, extraDatas)
      ).to.be.revertedWithCustomError(oracle, "ExpirySettlementPaused");

      // 6. Guardrail checks: empty reason & zero price rejected; unpaused expiry rejected
      await expect(
        oracle.connect(admin).emergencyManualSettle(ASSET_BTC, expiry, manualPrice8, "")
      ).to.be.revertedWithCustomError(oracle, "InvalidReason");
      await expect(
        oracle.connect(admin).emergencyManualSettle(ASSET_BTC, expiry, 0n, auditReason)
      ).to.be.revertedWithCustomError(oracle, "InvalidPrice");
      await expect(
        oracle.connect(admin).emergencyManualSettle(ASSET_ETH, expiry, 2000_00000000n, auditReason)
      ).to.be.revertedWithCustomError(oracle, "ExpiryNotPaused");

      // 7. Owner executes emergencyManualSettle with public audit reason
      await expect(
        oracle.connect(admin).emergencyManualSettle(ASSET_BTC, expiry, manualPrice8, auditReason)
      )
        .to.emit(oracle, "EmergencyExpirySettled")
        .withArgs(ASSET_BTC, expiry, manualPrice8, admin.address, auditReason);

      const [price, settled] = await oracle.getSettlementPrice(ASSET_BTC, expiry);
      expect(settled).to.equal(true);
      expect(price).to.equal(manualPrice8);
      expect(await oracle.isExpiryPaused(ASSET_BTC, expiry)).to.equal(false);

      const meta = await oracle.getSettlementMeta(ASSET_BTC, expiry);
      expect(meta.isManualOverride).to.equal(true);
      expect(meta.sampleCount).to.equal(0n);
      expect(meta.feedId).to.equal("0x00000000");
      expect(meta.submitter).to.equal(admin.address);
      expect(meta.overrideReason).to.equal(auditReason);

      // 8. Settled expiry can NEVER be overwritten or re-paused
      await expect(
        oracle.connect(pauser).pauseExpiry(ASSET_BTC, expiry)
      ).to.be.revertedWithCustomError(oracle, "AlreadySettled");
      await expect(
        oracle.connect(admin).emergencyManualSettle(ASSET_BTC, expiry, 1_00000000n, "retry")
      ).to.be.revertedWithCustomError(oracle, "AlreadySettled");

      // 9. Owner can unpause a false-alarm freeze so permissionless TWAP completes normally
      await oracle.connect(pauser).pauseExpiry(ASSET_ETH, expiry);
      await oracle.connect(admin).unpauseExpiry(ASSET_ETH, expiry);
      const ethTwap = buildSignedAtlasTwapProofs({
        signerPrivateKey: customSigner.privateKey,
        feedId: FEED_ID_ETH,
        expiry,
        prices18: 2050n * 10n ** 18n,
      });
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_ETH, expiry, ethTwap.extraDatas)
      ).to.emit(oracle, "ExpirySettled");
    });
  });

  describe("Live verifyLatestAtlasPrice Freshness & Governance", function () {
    it("verifies fresh live Atlas prices via eth_call and rejects stale prices (> maxLiveFreshness)", async function () {
      const { customSigner, oracle, oracleAddr } = await deployWithCustomSigner();
      const now = await time.latest();

      const btcPrice18 = 62345_67890123n * 10n ** 10n;
      const freshProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18: btcPrice18, timestamp: now - 15 },
      ]);
      const freshCall = encodeVerifyLatestAtlasPriceCalldata(
        oracle.interface,
        ASSET_BTC,
        freshProof.extraData
      );
      const raw = await ethers.provider.call({ to: oracleAddr, data: freshCall });
      const [price8, price18, aggregatedTs, feedId] = oracle.interface.decodeFunctionResult(
        "verifyLatestAtlasPrice",
        raw
      );
      expect(price8).to.equal(62345_67890123n);
      expect(price18).to.equal(btcPrice18);
      expect(aggregatedTs).to.equal(BigInt(now - 15));
      expect(feedId).to.equal(FEED_ID_BTC);

      const staleProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18: btcPrice18, timestamp: now - 181 },
      ]);
      const staleCall = encodeVerifyLatestAtlasPriceCalldata(
        oracle.interface,
        ASSET_BTC,
        staleProof.extraData
      );
      await expect(
        ethers.provider.call({ to: oracleAddr, data: staleCall })
      ).to.be.revertedWithCustomError(oracle, "StaleAtlasPrice");
    });

    it("enforces TwapConfig invariants and supports signer rotation, custom feeds, and Ownable2Step", async function () {
      const { admin, stranger, newAdmin, rogueSigner, oracle } = await deployWithCustomSigner();

      // Rejects invalid TWAP configs (zero count, window > 30m, overlapping fallback tolerance)
      await expect(
        oracle.connect(admin).setTwapConfig(0, 60, 60, 900, 10)
      ).to.be.revertedWithCustomError(oracle, "InvalidTwapConfig");
      await expect(
        oracle.connect(admin).setTwapConfig(31, 61, 60, 900, 10)
      ).to.be.revertedWithCustomError(oracle, "InvalidTwapConfig");
      await expect(
        oracle.connect(admin).setTwapConfig(10, 20, 60, 900, 10) // 2*10 >= 20 overlaps!
      ).to.be.revertedWithCustomError(oracle, "InvalidTwapConfig");

      // Valid custom TWAP config (6 samples * 5 min = 25m span)
      await expect(oracle.connect(admin).setTwapConfig(6, 300, 30, 600, 15))
        .to.emit(oracle, "TwapConfigUpdated")
        .withArgs(6, 300, 30, 600, 15);

      await expect(oracle.connect(admin).setAuthorizedSigner(rogueSigner.address))
        .to.emit(oracle, "AuthorizedSignerUpdated")
        .withArgs(rogueSigner.address);

      const ASSET_BNB = ethers.keccak256(ethers.toUtf8Bytes("BNB"));
      const FEED_BNB = "0x00000280";
      await oracle.connect(admin).setAssetFeedId(ASSET_BNB, FEED_BNB);

      const now = await time.latest();
      const expiry = now - 60;
      const { extraDatas } = buildSignedAtlasTwapProofs({
        signerPrivateKey: rogueSigner.privateKey,
        feedId: FEED_BNB,
        expiry,
        prices18: 615_50000000n * 10n ** 10n,
        count: 6,
        interval: 300,
      });
      await expect(
        oracle.connect(stranger).settleWithAtlasTwap(ASSET_BNB, expiry, extraDatas)
      ).to.emit(oracle, "ExpirySettled");

      await oracle.connect(admin).transferOwnership(newAdmin.address);
      await oracle.connect(newAdmin).acceptOwnership();
      expect(await oracle.owner()).to.equal(newAdmin.address);
    });
  });

  describe("MockUSDT (tUSDT)", function () {
    it("supports 6 decimals, public faucet(), capped faucet(amount), owner mint(), and freeze hook", async function () {
      const [admin, user, recipient] = await ethers.getSigners();
      const MockUSDT = await ethers.getContractFactory("MockUSDT");
      const usdt = await MockUSDT.deploy(admin.address);

      expect(await usdt.name()).to.equal("Tether USD (Testnet)");
      expect(await usdt.symbol()).to.equal("tUSDT");
      expect(await usdt.decimals()).to.equal(6n);

      await usdt.connect(user)["faucet()"]();
      expect(await usdt.balanceOf(user.address)).to.equal(ethers.parseUnits("1000", 6));

      await usdt.connect(user)["faucet(uint256)"](ethers.parseUnits("100000", 6));
      expect(await usdt.balanceOf(user.address)).to.equal(ethers.parseUnits("101000", 6));

      await expect(
        usdt.connect(user)["faucet(uint256)"](ethers.parseUnits("100001", 6))
      ).to.be.revertedWithCustomError(usdt, "FaucetCapExceeded");

      await expect(
        usdt.connect(user)["faucet(uint256)"](0n)
      ).to.be.revertedWithCustomError(usdt, "InvalidAmount");

      await usdt.connect(admin).mint(recipient.address, ethers.parseUnits("1000000", 6));
      expect(await usdt.balanceOf(recipient.address)).to.equal(
        ethers.parseUnits("1000000", 6)
      );

      await usdt.connect(admin).setFrozen(user.address, true);
      await expect(
        usdt.connect(user).transfer(recipient.address, ethers.parseUnits("10", 6))
      ).to.be.revertedWithCustomError(usdt, "AccountFrozen");
    });
  });
});
