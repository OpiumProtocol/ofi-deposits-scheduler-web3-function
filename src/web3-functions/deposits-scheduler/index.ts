import { Web3Function, Web3FunctionContext } from "@gelatonetwork/web3-functions-sdk"

import { checkDeposits } from './deposits'
import { checkWithdrawals } from './withdrawals'

Web3Function.onRun(async (context: Web3FunctionContext) => {
  const { userArgs } = context

  console.log('User args:', userArgs)

  if (userArgs.schedulerType == 'deposit') {
    return checkDeposits(userArgs.schedulerAddress as string, userArgs.subgraphName as string, context)
  }

  return checkWithdrawals(userArgs.schedulerAddress as string, userArgs.subgraphName as string, context)
})
