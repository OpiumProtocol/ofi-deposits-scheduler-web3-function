import { Web3FunctionContext } from "@gelatonetwork/web3-functions-sdk"
import { BigNumber, Contract } from "ethers"
import ky from "ky"

import {
  SUBGRAPH_BASE_URL, PAGE_LIMIT, BATCH_SIZE,
  SCHEDULER_ABI, SCHEDULER_INTERFACE, MULTICALL_INTERFACE, STAKING_ABI,
  checkIsStakingPhase
} from './utils'

type ScheduledWithdrawal = {
  user: string
  pool: string
}
async function fetchAllScheduledWithdrawals(subgraphName: string): Promise<ScheduledWithdrawal[]> {
  // Controlling variables
  let lastResponseLength = PAGE_LIMIT
  let skip = 0

  // Result array
  let result: ScheduledWithdrawal[] = []
  
  // Keep fetching pages till the end
  while (lastResponseLength == PAGE_LIMIT) {
    const response: { data: { withdrawals: ScheduledWithdrawal[] }} = await ky
      .post(
        SUBGRAPH_BASE_URL + subgraphName,
        {
          json: {
            query: `
            {
              withdrawals(where: { scheduled: true }, skip: ${skip}) {
                user
                pool
              }
            }
          `
          },
          timeout: 5_000,
          retry: 0
        }
      )
      .json()

    // Concat result array with the fetched withdrawals
    result = result.concat(response.data.withdrawals)

    // Update controlling variables
    lastResponseLength = response.data.withdrawals.length
    skip += response.data.withdrawals.length
  }

  return result
}

async function getScheduled(schedulerAddress: string, user: string, pool: string, context: Web3FunctionContext): Promise<BigNumber> {
  const { provider } = context
  const contract = new Contract(pool, STAKING_ABI, provider)

  let balance: BigNumber
  try {
    balance = await contract.balanceOf(user)
  } catch (e) {
    console.error(e)
    return BigNumber.from(0)
  }

  let allowance: BigNumber
  try {
    allowance = await contract.allowance(user, schedulerAddress)
  } catch (e) {
    console.error(e)
    return BigNumber.from(0)
  }

  if (allowance.gte(balance)) {
    return balance
  }

  return BigNumber.from(0)
}

// Cache to decrease the amount of external calls
const cachedCoefficients = new Map<string, BigNumber>()
async function getReserveCoefficient(schedulerAddress: string, pool: string, context: Web3FunctionContext): Promise<BigNumber> {
  if (cachedCoefficients.has(pool)) {
    return cachedCoefficients.get(pool) as BigNumber
  }
  
  const { provider } = context
  const contract = new Contract(schedulerAddress, SCHEDULER_ABI, provider)

  const coefficient: BigNumber = await contract.getReserveCoefficient(pool)

  cachedCoefficients.set(pool, coefficient)

  return coefficient
}

export async function checkWithdrawals(schedulerAddress: string, subgraphName: string, context: Web3FunctionContext) {
  // Recursively fetch all the withdrawals from subgraph
  const allWithdrawals = await fetchAllScheduledWithdrawals(subgraphName)

  console.log(`Total fetched length: ${allWithdrawals.length}`)

  // Define the batch - an array to store withdrawals that will be executed
  const batchedWithdrawals: string[] = []

  // Iterate over fetched withdrawals
  for (let index = 0; index < allWithdrawals.length; index++) {
    // Exit the loop if batch is full
    if (batchedWithdrawals.length >= BATCH_SIZE) {
      break
    }

    // Parse withdrawal object and it's properties
    const withdrawal = allWithdrawals[index]

    // Fetch reserve coefficient for the given pool
    const coefficient = await getReserveCoefficient(schedulerAddress, withdrawal.pool, context)

    // Fetch user allowance and scheduled
    const scheduled = await getScheduled(schedulerAddress, withdrawal.user, withdrawal.pool, context)

    // Fetch isStakingPhase
    const isStakingPhase = await checkIsStakingPhase(withdrawal.pool, context)

    // Check if scheduled deposit is greater than the reserve coefficient
    if (
      BigNumber.from(scheduled).gt(coefficient) &&
      isStakingPhase
    ) {
      // Prepare deposit execution call and push into the batch
      batchedWithdrawals.push(
        SCHEDULER_INTERFACE.encodeFunctionData("execute", [withdrawal.user, withdrawal.pool])
      )
    }
  }

  console.log(`Result batch length: ${batchedWithdrawals.length.toString()}`)

  // If batch is empty, return
  if (batchedWithdrawals.length === 0) {
    return {
      canExec: false,
      callData: ""
    }
  }

  // Unwind withdrawals batch into single multicall() call
  return {
    canExec: true,
    callData: MULTICALL_INTERFACE.encodeFunctionData(
      "aggregate",
      [
        batchedWithdrawals.map(
          callData => ({ target: schedulerAddress, callData })
        )
      ]
    )
  }
}
