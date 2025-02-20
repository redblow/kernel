import { EventSubscriber, WebWorkerTransport } from 'decentraland-rpc'
import { inject, Script } from 'decentraland-rpc/lib/client/Script'
import type { ILogOpts, ScriptingTransport } from 'decentraland-rpc/lib/common/json-rpc/types'
import type { IEngineAPI } from 'shared/apis/IEngineAPI'
import type { ParcelIdentity } from 'shared/apis/ParcelIdentity'
import type { ISceneStateStorageController } from 'shared/apis/SceneStateStorageController/ISceneStateStorageController'
import { Permissions } from 'shared/apis/Permissions'
import { defaultLogger } from 'shared/logger'
import { DevToolsAdapter } from './sdk/DevToolsAdapter'
import { RendererStatefulActor } from './stateful-scene/RendererStatefulActor'
import { BuilderStatefulActor } from './stateful-scene/BuilderStatefulActor'
import { serializeSceneState } from './stateful-scene/SceneStateDefinitionSerializer'
import { EnvironmentAPI } from 'shared/apis/EnvironmentAPI'
import { SceneStateDefinition } from './stateful-scene/SceneStateDefinition'

class StatefulWebWorkerScene extends Script {
  @inject('DevTools')
  devTools: any

  @inject('EngineAPI')
  engine!: IEngineAPI

  @inject('EnvironmentAPI')
  environmentAPI!: EnvironmentAPI

  @inject('ParcelIdentity')
  parcelIdentity!: ParcelIdentity

  @inject('Permissions')
  permissions!: Permissions

  @inject('SceneStateStorageController')
  sceneStateStorage!: ISceneStateStorageController

  private devToolsAdapter!: DevToolsAdapter
  private rendererActor!: RendererStatefulActor
  private builderActor!: BuilderStatefulActor
  private sceneDefinition!: SceneStateDefinition
  private eventSubscriber!: EventSubscriber

  constructor(transport: ScriptingTransport, opt?: ILogOpts) {
    super(transport, opt)
  }

  async systemDidEnable(): Promise<void> {
    this.devToolsAdapter = new DevToolsAdapter(this.devTools)
    const { cid: sceneId, land: land } = await this.parcelIdentity.getParcel()
    this.rendererActor = new RendererStatefulActor(this.engine, sceneId)
    this.eventSubscriber = new EventSubscriber(this.engine)
    this.builderActor = new BuilderStatefulActor(land, this.sceneStateStorage)

    const isEmpty: boolean = await this.parcelIdentity.getIsEmpty()

    //If it is not empty we fetch the state
    if (!isEmpty) {
      // Fetch stored scene
      this.sceneDefinition = await this.builderActor.getInititalSceneState()
      await this.builderActor.sendAssetsFromScene(this.sceneDefinition)

      // Send the initial state ot the renderer
      this.sceneDefinition.sendStateTo(this.rendererActor)

      this.log('Sent initial load')
    } else {
      this.sceneDefinition = new SceneStateDefinition()
    }

    // Listen to the renderer and update the local scene state
    this.rendererActor.forwardChangesTo(this.sceneDefinition)

    this.rendererActor.sendInitFinished()

    // Listen to scene state events
    this.listenToEvents(sceneId)
  }

  private listenToEvents(sceneId: string): void {
    // Listen to publish requests
    this.eventSubscriber.on('stateEvent', ({ data }) => {
      const { type, payload } = data
      if (type === 'PublishSceneState') {
        this.sceneStateStorage
          .publishSceneState(
            sceneId,
            payload.title,
            payload.description,
            payload.screenshot,
            serializeSceneState(this.sceneDefinition)
          )
          .catch((error) => this.error(`Failed to store the scene's state`, error))
      }
    })

    // Listen to save scene requests
    this.eventSubscriber.on('stateEvent', ({ data }) => {
      if (data.type === 'SaveSceneState') {
        this.sceneStateStorage
          .saveSceneState(serializeSceneState(this.sceneDefinition))
          .catch((error) => this.error(`Failed to save the scene's manifest`, error))
      }
    })

    // Listen to save project info requests
    this.eventSubscriber.on('stateEvent', ({ data }) => {
      const { type, payload } = data
      if (type === 'SaveProjectInfo') {
        this.sceneStateStorage
          .saveProjectInfo(
            serializeSceneState(this.sceneDefinition),
            payload.title,
            payload.description,
            payload.screenshot
          )
          .catch((error) => this.error(`Failed to save the scene's info`, error))
      }
    })
  }

  private error(context: string, error: Error) {
    if (this.devToolsAdapter) {
      this.devToolsAdapter.error(error)
    } else {
      defaultLogger.error(context, error)
    }
  }

  private log(...messages: any[]) {
    if (this.devToolsAdapter) {
      this.devToolsAdapter.log(...messages)
    } else {
      defaultLogger.info('', ...messages)
    }
  }
}

new StatefulWebWorkerScene(WebWorkerTransport(self))
