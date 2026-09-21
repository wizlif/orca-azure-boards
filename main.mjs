import { createAzureBoardsTaskSource } from './task-source.mjs'

export default function activate(orca) {
  orca.taskSources.register('azure-boards', createAzureBoardsTaskSource(orca.host))
}
