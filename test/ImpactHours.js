const { assertRevert } = require('@aragon/contract-helpers-test/src/asserts')
const ImpactHours = artifacts.require('ImpactHours')
const MiniMeToken = artifacts.require('MiniMeToken')
const MiniMeTokenFactory = artifacts.require('MiniMeTokenFactory')
const Hatch = artifacts.require('HatchMock')
const TokenManager = artifacts.require('TokenManagerMock')

const { newDao, installNewApp, createEqOraclePermissionParam, ANY_ENTITY } = require('@aragon/contract-helpers-test/src/aragon-os')
const { assertBn } = require('@aragon/contract-helpers-test/src/asserts')

const { hash: nameHash } = require('eth-ens-namehash')
const { bn, bigExp } = require('@aragon/contract-helpers-test/src/numbers')
const ZERO_ADDR = '0x' + '0'.repeat(40)

contract(
  'ImpactHours',
  ([appManager, accountIH90, accountIH10]) => {
    let impactHoursBase, tokenManagerBase, hatchBase, impactHours, hatch, hatchToken, impactHoursToken, tokenFactory
    let CLAIM_ROLE, MINT_ROLE, CLOSE_ROLE

    const PPM = 1000000
    const EXCHANGE_RATE = 10 * PPM
    const MAX_RATE = 100
    const EXPECTED_RAISE_PER_IH = 1

    before('deploy base apps', async () => {
      impactHoursBase = await ImpactHours.new()
      tokenManagerBase = await TokenManager.new()
      hatchBase = await Hatch.new()
      tokenFactory = await MiniMeTokenFactory.new()
      MINT_ROLE = await tokenManagerBase.MINT_ROLE()
      CLAIM_ROLE = await impactHoursBase.CLAIM_ROLE()
      CLOSE_ROLE = await hatchBase.CLOSE_ROLE()
    })

    before('create tokens', async () => {
      impactHoursToken = await MiniMeToken.new(tokenFactory.address, ZERO_ADDR, 0, "Impact Hours", 18, "IH", false, { from: appManager })
      await impactHoursToken.generateTokens(accountIH90, bigExp(90, 18))
      await impactHoursToken.generateTokens(accountIH10, bigExp(10, 18))
    })

    beforeEach('deploy dao and apps', async () => {
      ({dao, acl} = await newDao(appManager))

      impactHours = await ImpactHours.at(await installNewApp(
        dao,
        nameHash('impact-hours.aragonpm.test'),
        impactHoursBase.address,
        appManager
      ))

      tokenManager = await TokenManager.at(await installNewApp(
        dao,
        nameHash('token-manager.aragonpm.test'),
        tokenManagerBase.address,
        appManager
      ))

      hatch = await Hatch.at(await installNewApp(
        dao,
        nameHash('hatch.aragonpm.test'),
        hatchBase.address,
        appManager
      ))

      hatchToken = await MiniMeToken.new(tokenFactory.address, ZERO_ADDR, 0, "Community Token", 18, "CT", true, { from: appManager })

      await hatchToken.changeController(tokenManager.address, { from: appManager })
      await tokenManager.initialize(hatchToken.address)
      await hatch.initialize(tokenManager.address, EXCHANGE_RATE)

      await acl.createPermission(impactHours.address, tokenManager.address, MINT_ROLE, appManager)
      await acl.createPermission(ANY_ENTITY, impactHours.address, CLAIM_ROLE, appManager)
    })

    describe('initialize(MiniMeToken _token, address _hatch, uint256 _maxRate, uint256 _expectedRaisePerIH)', () => {
      beforeEach('initialize impact hours', async () => {
        await impactHours.initialize(impactHoursToken.address, hatch.address, MAX_RATE, EXPECTED_RAISE_PER_IH)
      })

      it('sets variables as expected', async () => {
        const actualHatch = await impactHours.hatch()
        const actualMaxRate = await impactHours.maxRate()
        const actualExpectedRaisePerIH = await impactHours.expectedRaisePerIH()
        const hasInitialized = await impactHours.hasInitialized()

        assert.strictEqual(actualHatch, hatch.address)
        assert.strictEqual(actualMaxRate.toString(), MAX_RATE.toString())
        assert.strictEqual(actualExpectedRaisePerIH.toString(), EXPECTED_RAISE_PER_IH.toString())
        assert.isTrue(hasInitialized)
      })

      it('has cloned the token and the control is kept by the impact hours contract', async () => {
        const actualToken = await MiniMeToken.at(await impactHours.token())
        assert.strictEqual(await actualToken.parentToken(), impactHoursToken.address)
        assert.strictEqual(await actualToken.controller(), impactHours.address)
      })

      it('reverts on reinitialization', async () => {
        await assertRevert(
          impactHours.initialize(impactHoursToken.address, hatch.address, MAX_RATE, EXPECTED_RAISE_PER_IH),
          'INIT_ALREADY_INITIALIZED'
        )
      })
    })

    describe('claimReward(address[] _contributors)', async () => {
      beforeEach('initialize impact hours', async () => {
        await impactHours.initialize(impactHoursToken.address, hatch.address, MAX_RATE, EXPECTED_RAISE_PER_IH)
      })

      it('can not claim if state is Pending', async () => {
        await hatch.setState(0) // Pending
        await assertRevert(impactHours.claimReward([accountIH90, accountIH10]), 'IH_HATCH_NOT_GOAL_REACHED')
      })

      it('can not claim if state is Funding', async () => {
        await hatch.setState(1) // Funding
        await assertRevert(impactHours.claimReward([accountIH90, accountIH10]), 'IH_HATCH_NOT_GOAL_REACHED')
      })

      it('can not claim if state is Refunding', async () => {
        await hatch.setState(2) // Refunding
        await assertRevert(impactHours.claimReward([accountIH90, accountIH10]), 'IH_HATCH_NOT_GOAL_REACHED')
      })

      it('can claim if state is Goal Reached', async () => {
        await hatch.setState(3) // Goal Reached
        await impactHours.claimReward([accountIH90, accountIH10])
      })

      it('can not claim if state is Closed', async () => {
        await hatch.setState(4) // Closed
        await assertRevert(impactHours.claimReward([accountIH90, accountIH10]), 'IH_HATCH_NOT_GOAL_REACHED')
      })

      it('destroys impact hours tokens when they are claimed', async() => {
        await hatch.setState(3)
        await impactHours.claimReward([accountIH90, accountIH10])
        const clonedToken = await MiniMeToken.at(await impactHours.token())
        assertBn(await clonedToken.balanceOf(accountIH90), bn(0))
        assertBn(await clonedToken.balanceOf(accountIH10), bn(0))
        assertBn(await clonedToken.totalSupply(), bn(0))
      })
    })

    const amount = (ih, maxRate, expectedRaise, raised) => ih.mul(maxRate).mul(raised).div(raised.add(expectedRaise))
    const loop = f => {
      for (let maxRate of [10, 100]) {
        for (let expectedRaisePerIH of [100, 10000]) {
          for (let raised of [0, 1000, 100000000]) {
            it(`maxRate = ${maxRate}, expectedRaisePerIH = ${expectedRaisePerIH}, totalRaised = ${raised}`, f(maxRate, expectedRaisePerIH, raised))
          }
        }
      }
    }

    describe('reward(uint256 totalRaised, address contributor))', async() => {
      loop((maxRate, expectedRaisePerIH, raised) => async() => {
        await impactHours.initialize(impactHoursToken.address, hatch.address, maxRate, expectedRaisePerIH)
        assertBn(
          await impactHours.reward(bigExp(raised, 18), accountIH90),
          amount(await impactHoursToken.balanceOf(accountIH90), bn(maxRate), bigExp(expectedRaisePerIH * 100, 18), bigExp(raised, 18))
        )
        assertBn(
          await impactHours.reward(bigExp(raised, 18), accountIH10),
          amount(await impactHoursToken.balanceOf(accountIH10), bn(maxRate), bigExp(expectedRaisePerIH * 100, 18), bigExp(raised, 18))
        )
      })
    })

    describe('claimReward(address[] _contributors)', async() => {
      loop((maxRate, expectedRaisePerIH, raised) => async() => {
        await hatch.setState(3)
        await hatch.contribute(bigExp(raised, 18))
        await impactHours.initialize(impactHoursToken.address, hatch.address, maxRate, expectedRaisePerIH)
        await impactHours.claimReward([accountIH90, accountIH10])
        for (let account of [accountIH90, accountIH10]) {
          const contributedAmount = amount(await impactHoursToken.balanceOf(account), bn(maxRate), bigExp(expectedRaisePerIH * 100, 18), bigExp(raised, 18))
          assertBn(await hatchToken.balanceOf(account), await hatch.contributionToTokens(contributedAmount))
        }
      })
    })

    describe('canPerform(address, address, bytes32, uint256[])', async() => {
      beforeEach('initialize impact hours', async () => {
        await impactHours.initialize(impactHoursToken.address, hatch.address, MAX_RATE, EXPECTED_RAISE_PER_IH)
      })
  
      it('can perform when all cloned impact hour tokens have been burned', async() => {
        await hatch.setState(3)
        await impactHours.claimReward([accountIH90, accountIH10])
        assert.isTrue(await impactHours.canPerform(ZERO_ADDR, ZERO_ADDR, '0x', []))
      })

      it('can not perform when not all cloned impact hour tokens have been burned', async() => {
        await hatch.setState(3)
        await impactHours.claimReward([accountIH90])
        assert.isFalse(await impactHours.canPerform(ZERO_ADDR, ZERO_ADDR, '0x', []))
      })
    })

    describe('hatch.close()', async() => {
      beforeEach(async() => {
        await impactHours.initialize(impactHoursToken.address, hatch.address, MAX_RATE, EXPECTED_RAISE_PER_IH)
        await acl.createPermission(ANY_ENTITY, hatch.address, CLOSE_ROLE, appManager)
        await acl.grantPermissionP(ANY_ENTITY, hatch.address, CLOSE_ROLE, [createEqOraclePermissionParam(impactHours.address)])
      })

      it('can not close the hatch if not all impact hours have been claimed', async () => {
        await hatch.setState(3)
        await impactHours.claimReward([accountIH90])
        await assertRevert(hatch.close())
      })

      it('can close when all impact hours have been claimed', async() => {
        await hatch.setState(3)
        await impactHours.claimReward([accountIH90, accountIH10])

        assert.isTrue(await impactHours.canPerform(ZERO_ADDR, ZERO_ADDR, '0x', []))
        await hatch.close()
      })
    })
  }
)
