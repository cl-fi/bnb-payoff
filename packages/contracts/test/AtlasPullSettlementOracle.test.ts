import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  ATLAS_MAGIC_MARKER,
  ATLAS_OFFICIAL_SIGNER,
  FEED_ID_BTC,
  FEED_ID_ETH,
  buildSignedAtlasProof,
  encodeSettleWithAtlasProofCalldata,
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

describe("AtlasPullSettlementOracle & MockUSDT", function () {
  async function deployWithCustomSigner() {
    const [admin, stranger, newAdmin] = await ethers.getSigners();
    const customSigner = ethers.Wallet.createRandom();
    const rogueSigner = ethers.Wallet.createRandom();

    const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
    const oracle = await Oracle.deploy(admin.address, customSigner.address);
    const oracleAddr = await oracle.getAddress();

    return {
      admin,
      stranger,
      newAdmin,
      customSigner,
      rogueSigner,
      oracle,
      oracleAddr,
    };
  }

  describe("Production Atlas Official Signer Verification (0x59eD...DC600)", function () {
    it("verifies and settles real production Atlas /v1/price/history 08:00 UTC BTC proof against official signer", async function () {
      const [admin, stranger] = await ethers.getSigners();
      const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
      const oracle = await Oracle.deploy(admin.address, ATLAS_OFFICIAL_SIGNER);
      const oracleAddr = await oracle.getAddress();

      // Ensure EVM clock is past the fixture expiry (deterministic across past & future clocks)
      const latest = await time.latest();
      if (latest < PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp + 10) {
        await time.increaseTo(PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp + 10);
      }

      const extraData = ethers.concat([
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.payload,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.signature,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.magicMarker,
      ]);

      const calldata = encodeSettleWithAtlasProofCalldata(
        oracle.interface,
        ASSET_BTC,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp,
        extraData
      );

      // Permissionless: any stranger can submit the valid Atlas proof
      await expect(stranger.sendTransaction({ to: oracleAddr, data: calldata }))
        .to.emit(oracle, "ExpirySettled")
        .withArgs(
          ASSET_BTC,
          PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp,
          PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.expectedPrice8,
          stranger.address,
          FEED_ID_BTC,
          PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp
        );

      const [price, settled] = await oracle.getSettlementPrice(
        ASSET_BTC,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp
      );
      expect(settled).to.equal(true);
      expect(price).to.equal(PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.expectedPrice8);

      const st = await oracle.getSettlement(
        ASSET_BTC,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp
      );
      expect(st.settled).to.equal(true);
      expect(st.price).to.equal(PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.expectedPrice8);
      expect(st.settledAt).to.be.greaterThan(0n);

      const [metaFeedId, metaOracleTs, metaSubmitter] = await oracle.getSettlementMeta(
        ASSET_BTC,
        PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp
      );
      expect(metaFeedId).to.equal(FEED_ID_BTC);
      expect(metaOracleTs).to.equal(BigInt(PRODUCTION_ATLAS_HISTORY_BTC_FIXTURE.timestamp));
      expect(metaSubmitter).to.equal(stranger.address);
    });

    it("verifies and settles both BTC (#626) and ETH (#632) from a single real multi-feed Atlas signed payload", async function () {
      const [admin, stranger] = await ethers.getSigners();
      const Oracle = await ethers.getContractFactory("AtlasPullSettlementOracle");
      const oracle = await Oracle.deploy(admin.address, ATLAS_OFFICIAL_SIGNER);
      const oracleAddr = await oracle.getAddress();

      const latest = await time.latest();
      if (latest < PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp + 10) {
        await time.increaseTo(PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp + 10);
      }

      const extraData = ethers.concat([
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.payload,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.signature,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.magicMarker,
      ]);

      // Settle BTC from the 2-feed payload
      const btcCall = encodeSettleWithAtlasProofCalldata(
        oracle.interface,
        ASSET_BTC,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp,
        extraData
      );
      await stranger.sendTransaction({ to: oracleAddr, data: btcCall });

      // Settle ETH from the same 2-feed payload
      const ethCall = encodeSettleWithAtlasProofCalldata(
        oracle.interface,
        ASSET_ETH,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp,
        extraData
      );
      await stranger.sendTransaction({ to: oracleAddr, data: ethCall });

      const [btcPrice, btcSettled] = await oracle.getSettlementPrice(
        ASSET_BTC,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp
      );
      const [ethPrice, ethSettled] = await oracle.getSettlementPrice(
        ASSET_ETH,
        PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.timestamp
      );

      expect(btcSettled).to.equal(true);
      expect(btcPrice).to.equal(PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.btc.expectedPrice8);
      expect(ethSettled).to.equal(true);
      expect(ethPrice).to.equal(PRODUCTION_ATLAS_LATEST_MULTI_FIXTURE.eth.expectedPrice8);
    });
  });

  describe("Expiry-Pinned Settlement Windows & Historical Proofs", function () {
    it("rejects pre-expiry settlement and timestamps outside [expiry - 60s, expiry + 60s], and accepts historical proofs hours after expiry", async function () {
      const { stranger, customSigner, oracle, oracleAddr } = await deployWithCustomSigner();

      const now = await time.latest();
      const expiry = now + 3600;
      const price18 = 65000_12345678n * 10n ** 10n;

      // 1. Pre-expiry reverts with ExpiryNotReached
      const preExpiryProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18, timestamp: now },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            preExpiryProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "ExpiryNotReached");

      // Advance 2 hours past expiry (simulating delayed historical /v1/price/history settlement)
      await time.increaseTo(expiry + 7200);

      // 2. Timestamp too early (expiry - 61) reverts with TimestampOutsideExpiryWindow
      const tooEarlyProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18, timestamp: expiry - 61 },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            tooEarlyProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "TimestampOutsideExpiryWindow");

      // 3. Timestamp too late (expiry + 61) reverts with TimestampOutsideExpiryWindow
      const tooLateProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18, timestamp: expiry + 61 },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            tooLateProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "TimestampOutsideExpiryWindow");

      // 4. Exact lower boundary (expiry - 60) succeeds even 2 hours after expiry!
      const exactLowerProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18, timestamp: expiry - 60 },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            exactLowerProof.extraData
          ),
        })
      )
        .to.emit(oracle, "ExpirySettled")
        .withArgs(
          ASSET_BTC,
          expiry,
          65000_12345678n,
          stranger.address,
          FEED_ID_BTC,
          expiry - 60
        );

      // 5. Exact upper boundary (expiry + 60) succeeds on ETH
      const exactUpperProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_ETH, price18: 2100_00000000n * 10n ** 10n, timestamp: expiry + 60 },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_ETH,
            expiry,
            exactUpperProof.extraData
          ),
        })
      ).to.emit(oracle, "ExpirySettled");

      // 6. Duplicate settlement reverts with AlreadySettled
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            exactLowerProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "AlreadySettled");
    });

    it("rejects zero timestamp and future-drifted timestamps (> block.timestamp + 60s)", async function () {
      const { stranger, customSigner, oracle, oracleAddr } = await deployWithCustomSigner();
      const now = await time.latest();
      const expiry = now - 10;

      // Zero timestamp
      const zeroTsProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18: 60000n * 10n ** 18n, timestamp: 0 },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            zeroTsProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "InvalidOracleTimestamp");

      // Future drift > 60s
      const futureTsProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18: 60000n * 10n ** 18n, timestamp: now + 120 },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            futureTsProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "InvalidOracleTimestamp");
    });
  });

  describe("Cryptographic Integrity, Feed Matching & Circuit Breaker Guards", function () {
    it("rejects unauthorized signer, tampered payload, wrong feedId, bad marker, missing extraData, and paused circuit breaker", async function () {
      const { admin, stranger, customSigner, rogueSigner, oracle, oracleAddr } =
        await deployWithCustomSigner();

      const now = await time.latest();
      const expiry = now - 5;
      const price18 = 61000n * 10n ** 18n;

      // 1. Unauthorized signer
      const rogueProof = buildSignedAtlasProof(rogueSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18, timestamp: expiry },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            rogueProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "UnauthorizedSigner");

      // 2. Tampered payload (mutate 1 byte of price after signing -> recovers wrong signer)
      const validProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_BTC, price18, timestamp: expiry },
      ]);
      const tamperedBytes = ethers.getBytes(validProof.payload);
      tamperedBytes[6] ^= 0xff;
      const tamperedExtraData = ethers.concat([
        ethers.hexlify(tamperedBytes),
        validProof.signature,
        ATLAS_MAGIC_MARKER,
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            tamperedExtraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "UnauthorizedSigner");

      // 3. Wrong feedId (ETH package submitted when settling BTC)
      const ethOnlyProof = buildSignedAtlasProof(customSigner.privateKey, [
        { feedId: FEED_ID_ETH, price18: 2000n * 10n ** 18n, timestamp: expiry },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            ethOnlyProof.extraData
          ),
        })
      )
        .to.be.revertedWithCustomError(oracle, "UnmatchedFeedID")
        .withArgs(FEED_ID_BTC);

      // 4. Bad magic marker
      const badMarkerProof = buildSignedAtlasProof(
        customSigner.privateKey,
        [{ feedId: FEED_ID_BTC, price18, timestamp: expiry }],
        "0xdead"
      );
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            badMarkerProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "InvalidMarker");

      // 5. Missing trailing extraData
      await expect(
        oracle.connect(stranger).settleWithAtlasProof(ASSET_BTC, expiry)
      ).to.be.revertedWithCustomError(oracle, "InsufficientMetadata");

      // 6. Unconfigured asset
      const unknownAsset = ethers.keccak256(ethers.toUtf8Bytes("SOL"));
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            unknownAsset,
            expiry,
            validProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "FeedNotConfigured");

      // 7. Emergency circuit breaker pause & resume
      await expect(
        oracle.connect(stranger).setSettlementPaused(true)
      ).to.be.revertedWithCustomError(oracle, "OwnableUnauthorizedAccount");

      await expect(oracle.connect(admin).setSettlementPaused(true))
        .to.emit(oracle, "SettlementPausedUpdated")
        .withArgs(true);

      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            validProof.extraData
          ),
        })
      ).to.be.revertedWithCustomError(oracle, "SettlementPaused");

      await oracle.connect(admin).setSettlementPaused(false);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BTC,
            expiry,
            validProof.extraData
          ),
        })
      ).to.emit(oracle, "ExpirySettled");
    });
  });

  describe("Live verifyLatestAtlasPrice Freshness & Governance", function () {
    it("verifies fresh live Atlas prices via eth_call and rejects stale prices (> maxLiveFreshness)", async function () {
      const { customSigner, oracle, oracleAddr } = await deployWithCustomSigner();
      const now = await time.latest();

      // Fresh payload passes
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

      // Stale payload (> 180s old) reverts with StaleAtlasPrice
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

    it("supports owner governance controls (signer rotation, custom feeds, window tuning, Ownable2Step)", async function () {
      const { admin, stranger, newAdmin, rogueSigner, oracle, oracleAddr } =
        await deployWithCustomSigner();

      // Rotate authorized signer to rogueSigner
      await expect(oracle.connect(admin).setAuthorizedSigner(rogueSigner.address))
        .to.emit(oracle, "AuthorizedSignerUpdated")
        .withArgs(rogueSigner.address);
      expect(await oracle.authorizedSigner()).to.equal(rogueSigner.address);

      // Register BNB custom feed
      const ASSET_BNB = ethers.keccak256(ethers.toUtf8Bytes("BNB"));
      const FEED_BNB = "0x00000280";
      await expect(oracle.connect(admin).setAssetFeedId(ASSET_BNB, FEED_BNB))
        .to.emit(oracle, "AssetFeedIdUpdated")
        .withArgs(ASSET_BNB, FEED_BNB);

      // Update settlement windows
      await expect(oracle.connect(admin).setSettlementWindows(90, 90, 300))
        .to.emit(oracle, "SettlementWindowsUpdated")
        .withArgs(90, 90, 300);

      await expect(
        oracle.connect(admin).setSettlementWindows(4000, 60, 180)
      ).to.be.revertedWithCustomError(oracle, "InvalidWindow");

      // Settle BNB using newly authorized signer & widened 90s lag
      const now = await time.latest();
      const expiry = now - 5;
      const bnbProof = buildSignedAtlasProof(rogueSigner.privateKey, [
        { feedId: FEED_BNB, price18: 615_50000000n * 10n ** 10n, timestamp: expiry - 85 },
      ]);
      await expect(
        stranger.sendTransaction({
          to: oracleAddr,
          data: encodeSettleWithAtlasProofCalldata(
            oracle.interface,
            ASSET_BNB,
            expiry,
            bnbProof.extraData
          ),
        })
      ).to.emit(oracle, "ExpirySettled");

      // Ownable2Step ownership transfer
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

      // Default faucet() mints 1,000 tUSDT
      await usdt.connect(user)["faucet()"]();
      expect(await usdt.balanceOf(user.address)).to.equal(ethers.parseUnits("1000", 6));

      // Parameterized faucet(uint256) capped at 100,000 tUSDT
      await usdt.connect(user)["faucet(uint256)"](ethers.parseUnits("100000", 6));
      expect(await usdt.balanceOf(user.address)).to.equal(ethers.parseUnits("101000", 6));

      await expect(
        usdt.connect(user)["faucet(uint256)"](ethers.parseUnits("100001", 6))
      ).to.be.revertedWithCustomError(usdt, "FaucetCapExceeded");

      await expect(
        usdt.connect(user)["faucet(uint256)"](0n)
      ).to.be.revertedWithCustomError(usdt, "InvalidAmount");

      // Owner mint is uncapped (used for MM 1,000,000 tUSDT margin funding)
      await usdt.connect(admin).mint(recipient.address, ethers.parseUnits("1000000", 6));
      expect(await usdt.balanceOf(recipient.address)).to.equal(
        ethers.parseUnits("1000000", 6)
      );

      // Freeze hook blocks transfers
      await usdt.connect(admin).setFrozen(user.address, true);
      await expect(
        usdt.connect(user).transfer(recipient.address, ethers.parseUnits("10", 6))
      ).to.be.revertedWithCustomError(usdt, "AccountFrozen");
    });
  });
});
