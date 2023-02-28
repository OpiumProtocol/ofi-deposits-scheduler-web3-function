import { Web3FunctionContext } from "@gelatonetwork/web3-functions-sdk"
import { Contract, utils } from "ethers"

// Constants
export const SUBGRAPH_BASE_URL = "https://api.thegraph.com/subgraphs/name/opiumprotocol/"
export const PAGE_LIMIT = 100
export const BATCH_SIZE = 5

// ABIs
export const SCHEDULER_ABI = [
  "function getReserveCoefficient(address) external view returns(uint256)",
  "function execute(address, address)"
]
export const SCHEDULER_INTERFACE = new utils.Interface(SCHEDULER_ABI)

const MULTICALL_ABI = [
  "function aggregate(tuple(address target, bytes callData)[] memory calls)"
]
export const MULTICALL_INTERFACE = new utils.Interface(MULTICALL_ABI)

export const STAKING_ABI = [
  "function balanceOf(address) external view returns(uint256)",
  "function allowance(address, address) external view returns(uint256)",
  "function underlying() external view returns(address)",
  "function derivative() external view returns((uint256,uint256,address,address,address))",
  "function EPOCH() external view returns(uint256)",
  "function STAKING_PHASE() external view returns(uint256)",
  "function TIME_DELTA() external view returns(uint256)"
]

// Helpers

// Cache to decrease the amount of external calls
const cachedIsStakingPhase = new Map<string, boolean>()
export async function checkIsStakingPhase(pool: string, context: Web3FunctionContext): Promise<boolean> {
  const { gelatoArgs, provider } = context
  const now = gelatoArgs.blockTime

  if (cachedIsStakingPhase.has(pool)) {
    return cachedIsStakingPhase.get(pool) as boolean
  }

  const contract = new Contract(pool, STAKING_ABI, provider)

  let isStakingPhase: boolean

  try {
    const derivativeData = await contract.derivative()
    const endTime = Number.parseInt(derivativeData[1])
    const epochLength = Number.parseInt(await contract.EPOCH())
    const stakingLength = Number.parseInt(await contract.STAKING_PHASE())
    const deltaLength = Number.parseInt(await contract.TIME_DELTA())

    // derivative maturity - EPOCH + TIME_DELTA < now < derivative maturity - EPOCH + STAKING_PHASE - TIME_DELTA
    isStakingPhase = (endTime - epochLength + deltaLength < now) && (now < endTime - epochLength + stakingLength - deltaLength)
  } catch (e) {
    return false
  }
  
  cachedIsStakingPhase.set(pool,isStakingPhase)

  return isStakingPhase
}
