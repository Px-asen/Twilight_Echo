import { TwilightAutoMixCoordinator as Coordinator, type TwilightAutoMixCoordinatorDependencies } from './autoMixCoordinator.ts'
import { identifyTwilightAutoMixFile } from './twilightAutoMixCache.ts'
export * from './autoMixCoordinator.ts'
/** Desktop defaults keep their file identity contract and existing entry point. */
export class TwilightAutoMixCoordinator extends Coordinator {
  constructor(dependencies: TwilightAutoMixCoordinatorDependencies) {
    super({ ...dependencies, identify: dependencies.identify ?? identifyTwilightAutoMixFile })
  }
}
