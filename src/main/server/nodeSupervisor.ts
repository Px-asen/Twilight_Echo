import { join } from 'node:path'
import { CoreSupervisor, type CoreSupervisorOptions } from '../coreProcess/supervisor.ts'
import { audioServiceEnv } from '../audio/audioServiceEnvironment.ts'
import { createNodeServiceChannel, NodeSupervisedProcess } from './nodeHost.ts'

export function createNodeCoreSupervisor(options: {
  applicationRoot: string
  entryDirectory: string
  configuration: CoreSupervisorOptions['configuration']
  platform: CoreSupervisorOptions['platform']
  stopOutputs?: CoreSupervisorOptions['stopOutputs']
  observe?(child: NodeSupervisedProcess, service: string): void
}): CoreSupervisor {
  const entry = (name: string) => join(options.entryDirectory, `${name}.cjs`)
  return new CoreSupervisor({
    configuration: options.configuration,
    platform: options.platform,
    stopOutputs: options.stopOutputs,
    entries: {
      core: entry('musicCore'),
      audio: entry('audioEngineService'),
      'audio-test': entry('audioEngineService'),
      database: entry('libraryDatabaseService'),
      scan: entry('libraryScanService'),
      analysis: entry('audioAnalysisService'),
      'model-install': entry('modelPackWorker'),
      plugin: entry('pluginHost')
    },
    channel: createNodeServiceChannel,
    fork: (serviceEntry, args, name) => {
      const child = new NodeSupervisedProcess({
        bootstrap: entry('bootstrap'),
        entry: serviceEntry,
        args,
        cwd: options.applicationRoot,
        env: ['twilight-audio', 'twilight-audio-test', 'twilight-zone-audio'].includes(name)
          ? audioServiceEnv()
          : process.env
      })
      options.observe?.(child, name)
      return child
    }
  })
}
