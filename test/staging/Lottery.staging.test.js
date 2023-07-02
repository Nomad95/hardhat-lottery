const { assert, expect } = require("chai")
const { getNamedAccounts, deployments, ethers, network } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

developmentChains.includes(network.name)
    ? describe.skip
    : describe("Lottery", () => {
          let lottery, lotteryEntranceFee, deployer, interval

          beforeEach(async () => {
              deployer = (await getNamedAccounts()).deployer
              lottery = await ethers.getContract("Lottery", deployer)
              lotteryEntranceFee = await lottery.getEntranceFee()
              interval = await lottery.getInterval()
          })

          describe("fulfillRandomWords", () => {
              it("works with live chainlink keepers and VRF - get a random winner", async () => {
                  //const lotteryState = await lottery.getLotteryState()
                  const startingTImestamp = await lottery.getLatestTimestamp()
                  console.log(startingTImestamp)
                  const accounts = await ethers.getSigners()

                  await new Promise(async (resolve, reject) => {
                      lottery.once("WinnerPicked", async () => {
                          console.log("WinnerPicked event fired")

                          try {
                              const recentWinner = await lottery.getRecentWinner()
                              const lotteryState = await lottery.getLotteryState()
                              const winnerEndingBalance = await accounts[0].getBalance()
                              const endingTimestamp = await lottery.getLatestTimestamp()
                              console.log(endingTimestamp)

                              await expect(lottery.getPlayer(0)).to.be.reverted
                              assert.equal(recentWinner.toString(), accounts[0].address)
                              assert.equal(lotteryState, 0)
                              //assert.equal(winnerEndingBalance.toString(), winnerStartingBalance.toString())
                              assert(endingTimestamp > startingTImestamp)

                              resolve()
                          } catch (error) {
                              console.log(error)
                              reject(e)
                          }
                      })

                      const tx = await lottery.enterLottery({ value: lotteryEntranceFee })
                      await tx.wait(1)
                      const winnerStartingBalance = await accounts[0].getBalance()
                  })
              })
          })
      })
