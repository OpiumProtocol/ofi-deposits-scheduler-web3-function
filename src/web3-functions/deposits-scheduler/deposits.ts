import { Web3FunctionContext } from "@gelatonetwork/web3-functions-sdk"
import { BigNumber, Contract } from "ethers"
import ky from "ky"

import {
  SUBGRAPH_BASE_URL, PAGE_LIMIT, BATCH_SIZE,
  SCHEDULER_ABI, SCHEDULER_INTERFACE, MULTICALL_INTERFACE, STAKING_ABI,
  checkIsStakingPhase
} from './utils'

type ScheduledDeposit = {
  user: string
  pool: string
  scheduled: string
}
async function fetchAllScheduledDeposits(subgraphName: string): Promise<ScheduledDeposit[]> {
  // Controlling variables
  let lastResponseLength = PAGE_LIMIT
  let skip = 0

  // Result array
  let result: ScheduledDeposit[] = []
  
  // Keep fetching pages till the end
  while (lastResponseLength == PAGE_LIMIT) {
    const response: { data: { deposits: ScheduledDeposit[] }} = await ky
      .post(
        SUBGRAPH_BASE_URL + subgraphName,
        {
          json: {
            query: `
              {
                deposits(where: { scheduled_gt: 0 }, skip: ${skip}) {
                  user
                  pool
                  scheduled
                }
              }
            `
          },
          timeout: 5_000,
          retry: 0
        }
      )
      .json()

    // Concat result array with the fetched deposits
    result = result.concat(response.data.deposits)

    // Update controlling variables
    lastResponseLength = response.data.deposits.length
    skip += response.data.deposits.length
  }

  return result
}

// Cache to decrease the amount of external calls
const cachedUnderlying = new Map<string, string>()
async function getUnderlying(pool: string, context: Web3FunctionContext): Promise<string> {
  if (cachedUnderlying.has(pool)) {
    return cachedUnderlying.get(pool) as string
  }

  const { provider } = context
  const contract = new Contract(pool, STAKING_ABI, provider)
  
  const underlying: string = await contract.underlying()
  
  cachedUnderlying.set(pool, underlying)

  return underlying
}

// Cache to decrease the amount of external calls
const cachedCoefficients = new Map<string, BigNumber>()
async function getReserveCoefficient(schedulerAddress: string, pool: string, context: Web3FunctionContext): Promise<BigNumber> {
  const underlying = await getUnderlying(pool, context)

  if (cachedCoefficients.has(underlying)) {
    return cachedCoefficients.get(underlying) as BigNumber
  }

  const { provider } = context
  const contract = new Contract(schedulerAddress, SCHEDULER_ABI, provider)

  const coefficient: BigNumber = await contract.getReserveCoefficient(underlying)

  cachedCoefficients.set(underlying, coefficient)

  return coefficient
}

export async function checkDeposits(schedulerAddress: string, subgraphName: string, context: Web3FunctionContext) {
  // Recursively fetch all the deposits from subgraph
  const allDeposits = await fetchAllScheduledDeposits(subgraphName)

  console.log(`Total fetched length: ${allDeposits.length.toString()}`)

  // Define the batch - an array to store deposits that will be executed
  const batchedDeposits: string[] = []

  // Iterate over fetched deposits
  for (let index = 0; index < allDeposits.length; index++) {
    // Exit the loop if batch is full
    if (batchedDeposits.length >= BATCH_SIZE) {
      break
    }

    // Parse deposit object and it's properties
    const deposit = allDeposits[index]

    // Fetch reserve coefficient for the given pool
    const coefficient = await getReserveCoefficient(schedulerAddress, deposit.pool, context)

    // Fetch isStakingPhase
    const isStakingPhase = await checkIsStakingPhase(deposit.pool, context)

    // Check if scheduled deposit is greater than the reserve coefficient
    if (
      BigNumber.from(deposit.scheduled).gt(coefficient) &&
      isStakingPhase
    ) {
      // Prepare deposit execution call and push into the batch
      batchedDeposits.push(
        SCHEDULER_INTERFACE.encodeFunctionData("execute", [deposit.user, deposit.pool])
      )
    }
  }

  console.log(`Result batch length: ${batchedDeposits.length.toString()}`)

  // If batch is empty, return
  if (batchedDeposits.length === 0) {
    return {
      canExec: false,
      callData: ""
    }
  }

  // Unwind deposits batch into single multicall() call
  return {
    canExec: true,
    callData: MULTICALL_INTERFACE.encodeFunctionData(
      "aggregate",
      [
        batchedDeposits.map(
          callData => ({ target: schedulerAddress, callData })
        )
      ]
    )
  }
}
