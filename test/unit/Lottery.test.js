const { assert, expect } = require("chai")
const { getNamedAccounts, deployments, ethers, network } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Lottery", () => {
          let lottery, vrfCoordinatorV2Mock, lotteryEntranceFee, deployer, interval
          const chainId = network.config.chainId

          beforeEach(async () => {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture(["all"])
              lottery = await ethers.getContract("Lottery", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              lotteryEntranceFee = await lottery.getEntranceFee()
              interval = await lottery.getInterval()
          })

          describe("constructor", () => {
              it("inits the lottery correctly", async () => {
                  const lotteryState = await lottery.getLotteryState()

                  assert.equal(lotteryState.toString(), "0")
                  assert.equal(interval.toString(), networkConfig[chainId]["interval"])
              })
          })

          describe("enterLottery", () => {
              it("reverts when you dont pay enough", async () => {
                  await expect(lottery.enterLottery()).to.be.revertedWith("Lottery__NotEnoughETHEntered")
              })
              it("records players when they enter", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  const playerFromContract = await lottery.getPlayer(0)
                  assert.equal(playerFromContract, deployer)
              })
              it("emits event on enter", async () => {
                  await expect(lottery.enterLottery({ value: lotteryEntranceFee })).to.emit(lottery, "LotteryEntered")
              })
              it("doesnt allow entrance when lottery is calculating", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })

                  //simulate time passed
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])

                  //simulate mining next block
                  await network.provider.send("evm_mine", [])

                  //simulate being Chainlink Keeper
                  await lottery.performUpkeep([])

                  await expect(lottery.enterLottery({ value: lotteryEntranceFee })).to.be.revertedWith("Lottery__NotOpen")
              })
          })
          describe("checkUpkeep", () => {
              it("returns false if people haven't sent eny ETH", async () => {
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  //simulate sending a transaction (just call)
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])

                  assert(!upkeepNeeded)
              })
              it("returns false if lottery is not open", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await lottery.performUpkeep([])

                  const lotteryState = await lottery.getLotteryState()
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep([])

                  assert.equal(lotteryState, "1")
                  assert.equal(upkeepNeeded, false)
              })
              it("returns false if enough time hasn't passed", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() - 5]) // use a higher number here if this test fails
                  await network.provider.request({
                      method: "evm_mine",
                      params: [],
                  })
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep("0x")

                  assert(!upkeepNeeded)
              })
              it("returns true if enough time has passed, has players, eth, and is open", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.request({
                      method: "evm_mine",
                      params: [],
                  })
                  const { upkeepNeeded } = await lottery.callStatic.checkUpkeep("0x")

                  assert(upkeepNeeded)
              })
          })
          describe("performUpkeep", () => {
              it("can only run if checkUpkeep is true", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  const tx = await lottery.performUpkeep([])

                  assert(tx)
              })
              it("reverts when checkUpkeep is false", async () => {
                  await expect(lottery.performUpkeep([])).to.be.revertedWith("Lottery__UpkeepNotNeeded") //or string interpolation with params
              })
              it("updates the lottery, emits event, and calls the vrf coordinator", async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  const txResponse = await lottery.performUpkeep([])
                  const txReceipt = await txResponse.wait(1)
                  const requestId = txReceipt.events[1].args.requestId
                  const lotteryState = await lottery.getLotteryState()

                  assert(requestId.toNumber() > 0)
                  assert.equal(lotteryState, 1)
              })
          })
          describe("fulfillRandomWords", () => {
              beforeEach(async () => {
                  await lottery.enterLottery({ value: lotteryEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
              })

              it("can only be called after performUpkeep", async () => {
                  await expect(vrfCoordinatorV2Mock.fulfillRandomWords(0, lottery.address)).to.be.revertedWith("nonexistent request")
                  await expect(vrfCoordinatorV2Mock.fulfillRandomWords(1, lottery.address)).to.be.revertedWith("nonexistent request")
              })
              it("picks a winnerm resets the lottery, and sends money", async () => {
                  const additonalEntrants = 3
                  const startingAccountIndex = 1 //deployer == 0
                  const accounts = await ethers.getSigners()
                  for (let i = startingAccountIndex; i < startingAccountIndex + additonalEntrants; i++) {
                      const accountConnectedLottery = lottery.connect(accounts[i])
                      await accountConnectedLottery.enterLottery({
                          value: lotteryEntranceFee,
                      })
                  }

                  const startingTimeStamp = await lottery.getLatestTimestamp()

                  await new Promise(async (resolve, reject) => {
                      lottery.once("WinnerPicked", async () => {
                          console.log("Event found!")

                          try {
                              const recentWinner = await lottery.getRecentWinner()
                              const raffleState = await lottery.getLotteryState()
                              const endingTimestamp = await lottery.getLatestTimestamp()
                              const numPlayers = await lottery.getNumberOfPlayers()
                              const winnerEndingBalance = await accounts[1].getBalance()

                              assert.equal(recentWinner, accounts[1].address)
                              assert.equal(numPlayers, 0)
                              assert.equal(raffleState, 0)
                              assert(endingTimestamp > startingTimeStamp)
                              assert.equal(winnerEndingBalance.toString(), winnerStartingBalance.add(lotteryEntranceFee.mul(additonalEntrants).add(lotteryEntranceFee).toString()))

                              resolve()
                          } catch (e) {
                              reject(e)
                          }
                      })

                      const tx = await lottery.performUpkeep([])

                      const txReceipt = await tx.wait(1)
                      const winnerStartingBalance = await accounts[1].getBalance()

                      await vrfCoordinatorV2Mock.fulfillRandomWords(txReceipt.events[1].args.requestId, lottery.address)
                  })
              })
          })
      })
