import { exposeMethod, setAPIName } from 'decentraland-rpc/lib/host'
import { getFromPersistentStorage, saveToPersistentStorage } from 'atomicHelpers/persistentStorage'
import { ContentClient } from 'dcl-catalyst-client'
import { EntityType, Pointer, ContentFileHash } from 'dcl-catalyst-commons'
import { Authenticator } from 'dcl-crypto'
import { ExposableAPI } from '../ExposableAPI'
import { defaultLogger } from '../../logger'
import { DEBUG } from '../../../config'
import {
  Asset,
  AssetId,
  BuilderAsset,
  BuilderManifest,
  CONTENT_PATH,
  DeploymentResult,
  SceneDeploymentSourceMetadata,
  SerializedSceneState
} from './types'
import { getCurrentIdentity } from 'shared/session/selectors'
import { BuilderServerAPIManager } from './BuilderServerAPIManager'
import {
  fromBuildertoStateDefinitionFormat,
  fromSerializedStateToStorableFormat,
  fromStorableFormatToSerializedState,
  StorableSceneState,
  toBuilderFromStateDefinitionFormat
} from './StorableSceneStateTranslation'
import { uuid } from 'atomicHelpers/math'
import { CLASS_ID } from '@dcl/legacy-ecs'
import { ParcelIdentity } from '../ParcelIdentity'
import { getFetchContentServer, getSelectedNetwork } from 'shared/dao/selectors'
import { createGameFile } from './SceneStateDefinitionCodeGenerator'
import { SceneStateDefinition } from 'scene-system/stateful-scene/SceneStateDefinition'
import { ExplorerIdentity } from 'shared/session/types'
import { deserializeSceneState, serializeSceneState } from 'scene-system/stateful-scene/SceneStateDefinitionSerializer'
import { ISceneStateStorageController } from './ISceneStateStorageController'
import { base64ToBlob } from 'atomicHelpers/base64ToBlob'
import { getLayoutFromParcels } from './utils'
import { SceneTransformTranslator } from './SceneTransformTranslator'
import { getUnityInstance } from 'unity-interface/IUnityInterface'
import { store } from 'shared/store/isolatedStore'

export class SceneStateStorageController extends ExposableAPI implements ISceneStateStorageController {
  private parcelIdentity = this.options.getAPIInstance(ParcelIdentity)
  private builderManifest!: BuilderManifest
  private transformTranslator!: SceneTransformTranslator

  // lazy loading the BuilderServerAPIManager
  private _builderApiManager?: BuilderServerAPIManager
  private get builderApiManager(): BuilderServerAPIManager {
    if (!this._builderApiManager) {
      const net = getSelectedNetwork(store.getState())
      this._builderApiManager = new BuilderServerAPIManager(net)
    }
    return this._builderApiManager
  }

  @exposeMethod
  async getProjectManifest(projectId: string): Promise<SerializedSceneState | undefined> {
    const manifest = await this.builderApiManager.getBuilderManifestFromProjectId(projectId, this.getIdentity())

    if (!manifest) return undefined

    getUnityInstance().SendBuilderProjectInfo(manifest.project.title, manifest.project.description, false)
    this.builderManifest = manifest
    this.transformTranslator = new SceneTransformTranslator(this.parcelIdentity.land.sceneJsonData.source)
    const definition = fromBuildertoStateDefinitionFormat(manifest.scene, this.transformTranslator)
    return serializeSceneState(definition)
  }

  @exposeMethod
  async getProjectManifestByCoordinates(land: string): Promise<SerializedSceneState | undefined> {
    const newProject = await this.builderApiManager.getBuilderManifestFromLandCoordinates(land, this.getIdentity())
    if (newProject) {
      getUnityInstance().SendBuilderProjectInfo(newProject.project.title, newProject.project.description, false)
      this.builderManifest = newProject
      this.transformTranslator = new SceneTransformTranslator(this.parcelIdentity.land.sceneJsonData.source)
      const translatedManifest = fromBuildertoStateDefinitionFormat(
        this.builderManifest.scene,
        this.transformTranslator
      )
      return serializeSceneState(translatedManifest)
    }
    return undefined
  }

  @exposeMethod
  async createProjectWithCoords(coordinates: string): Promise<boolean> {
    const newProject = await this.builderApiManager.createProjectWithCoords(coordinates, this.getIdentity())
    getUnityInstance().SendBuilderProjectInfo(newProject.project.title, newProject.project.description, true)
    this.builderManifest = newProject
    this.transformTranslator = new SceneTransformTranslator(this.parcelIdentity.land.sceneJsonData.source)
    return newProject ? true : false
  }

  @exposeMethod
  async saveSceneState(serializedSceneState: SerializedSceneState): Promise<DeploymentResult> {
    let result: DeploymentResult

    try {
      // Deserialize the scene state
      const sceneState: SceneStateDefinition = deserializeSceneState(serializedSceneState)

      // Convert the scene state to builder scheme format
      const builderManifest = await toBuilderFromStateDefinitionFormat(
        sceneState,
        this.builderManifest,
        this.builderApiManager,
        this.transformTranslator
      )

      // Update the manifest
      await this.builderApiManager.updateProjectManifest(builderManifest, this.getIdentity())
      result = { ok: true }
    } catch (error) {
      defaultLogger.error('Saving manifest failed', error)
      result = { ok: false, error: `${error}` }
    }
    return result
  }

  @exposeMethod
  async saveProjectInfo(
    sceneState: SerializedSceneState,
    projectName: string,
    projectDescription: string,
    projectScreenshot: string
  ): Promise<boolean> {
    let result: boolean
    try {
      const thumbnailBlob: Blob = base64ToBlob(projectScreenshot, 'image/png')
      await this.updateProjectDetails(sceneState, projectName, projectDescription, thumbnailBlob)
      result = true
    } catch (error) {
      defaultLogger.error('Project details updating failed', error)
      result = false
    }

    return result
  }

  @exposeMethod
  async publishSceneState(
    sceneId: string,
    sceneName: string,
    sceneDescription: string,
    sceneScreenshot: string,
    sceneState: SerializedSceneState
  ): Promise<DeploymentResult> {
    let result: DeploymentResult

    // Convert to storable format
    const storableFormat = fromSerializedStateToStorableFormat(sceneState)

    if (DEBUG) {
      await saveToPersistentStorage(`scene-state-${sceneId}`, storableFormat)
      result = { ok: true }
    } else {
      try {
        const thumbnailBlob: Blob = base64ToBlob(sceneScreenshot, 'image/png')

        // Fetch all asset metadata
        const assets = await this.getAllAssets(sceneState)

        const assetsArray = await this.getAllBuilderAssets(sceneState)

        // Download asset files
        const models = await this.downloadAssetFiles(assets)

        // Generate game file
        const gameFile: string = createGameFile(sceneState, assets)

        // Prepare scene.json
        const sceneJson = this.parcelIdentity.land.sceneJsonData
        sceneJson.display = {
          title: sceneName,
          description: sceneDescription,
          navmapThumbnail: CONTENT_PATH.SCENE_THUMBNAIL
        }

        // Group all entity files
        const entityFiles: Map<string, Buffer> = new Map([
          [CONTENT_PATH.DEFINITION_FILE, Buffer.from(JSON.stringify(storableFormat))],
          [CONTENT_PATH.BUNDLED_GAME_FILE, Buffer.from(gameFile)],
          [CONTENT_PATH.SCENE_FILE, Buffer.from(JSON.stringify(sceneJson))],
          [CONTENT_PATH.SCENE_THUMBNAIL, await blobToBuffer(thumbnailBlob)],
          [CONTENT_PATH.ASSETS, Buffer.from(JSON.stringify(assetsArray))],
          ...models
        ])

        // Deploy
        const contentClient = this.getContentClient()

        // Build the entity
        const parcels = this.getParcels()
        const { files, entityId } = await contentClient.buildEntity({
          type: EntityType.SCENE,
          pointers: parcels,
          files: entityFiles,
          metadata: {
            ...sceneJson,
            source: {
              origin: 'builder-in-world',
              version: 1,
              projectId: this.builderManifest.project.id,
              rotation: this.parcelIdentity.land.sceneJsonData.source?.rotation ?? 'east',
              layout: this.parcelIdentity.land.sceneJsonData.source?.layout ?? getLayoutFromParcels(parcels),
              point:
                this.parcelIdentity.land.sceneJsonData.source?.point ??
                this.parcelIdentity.land.sceneJsonData.scene.base
            } as SceneDeploymentSourceMetadata
          }
        })

        // Sign entity id
        const identity = getCurrentIdentity(store.getState())
        if (!identity) {
          throw new Error('Identity not found when trying to deploy an entity')
        }
        const authChain = Authenticator.signPayload(identity, entityId)

        await contentClient.deployEntity({ files, entityId, authChain })

        // Update the project name, desc and thumbnail. unlink coordinates from builder project
        this.builderManifest.project.creation_coords = undefined
        await this.updateProjectDetails(sceneState, sceneName, sceneDescription, thumbnailBlob)

        result = { ok: true }
      } catch (error) {
        defaultLogger.error('Deployment failed', error)
        result = { ok: false, error: `${error}` }
      }
    }
    getUnityInstance().SendPublishSceneResult(result)
    return result
  }

  @exposeMethod
  async getStoredState(sceneId: string): Promise<SerializedSceneState | undefined> {
    if (DEBUG) {
      const sceneState: StorableSceneState = await getFromPersistentStorage(`scene-state-${sceneId}`)
      if (sceneState) {
        return fromStorableFormatToSerializedState(sceneState)
      }
      defaultLogger.warn(`Couldn't find a local scene state for scene ${sceneId}`)
      // NOTE: RPC controllers should NEVER return undefined. Use null instead
      return undefined
    }

    const contentClient = this.getContentClient()
    try {
      // Fetch the entity and find the definition's hash
      const scene = await contentClient.fetchEntityById(EntityType.SCENE, this.parcelIdentity.cid, { attempts: 3 })
      const definitionHash: ContentFileHash | undefined = scene.content?.find(
        ({ file }) => file === CONTENT_PATH.DEFINITION_FILE
      )?.hash

      if (definitionHash) {
        // Download the definition and return it
        const definitionBuffer = await contentClient.downloadContent(definitionHash, { attempts: 3 })
        const definitionFile = JSON.parse(definitionBuffer.toString())
        return fromStorableFormatToSerializedState(definitionFile)
      } else {
        defaultLogger.warn(
          `Couldn't find a definition file on the content server for the current scene (${this.parcelIdentity.cid})`
        )
      }
    } catch (e) {
      defaultLogger.error(`Failed to fetch the current scene (${this.parcelIdentity.cid}) from the content server`, e)
    }
  }

  @exposeMethod
  async createProjectFromStateDefinition(): Promise<SerializedSceneState | undefined> {
    const sceneJson = this.parcelIdentity.land.sceneJsonData
    const sceneId: string = this.parcelIdentity.land.sceneId
    const baseParcel: string = sceneJson.scene.base
    const parcels: string[] = sceneJson.scene.parcels
    const title: string | undefined = sceneJson.display?.title
    const description: string | undefined = sceneJson.display?.description

    try {
      const serializedScene = await this.getStoredState(sceneId)
      if (serializedScene) {
        const identity = this.getIdentity()
        const contentClient = this.getContentClient()

        const assetsFileHash: string | undefined = this.parcelIdentity.land.mappingsResponse.contents.find(
          (pair) => pair.file === CONTENT_PATH.ASSETS
        )?.hash
        if (assetsFileHash) {
          const assetJson = await contentClient.downloadContent(assetsFileHash, { attempts: 3 })

          if (assetJson) {
            const assets: BuilderAsset[] = JSON.parse(assetJson.toString())
            this.builderApiManager.addBuilderAssets(assets)
          }
        }

        // Create builder manifest from serialized scene
        const builderManifest = await this.builderApiManager.builderManifestFromSerializedState(
          uuid(),
          uuid(),
          baseParcel,
          parcels,
          title,
          description,
          identity.rawAddress,
          serializedScene,
          this.parcelIdentity.land.sceneJsonData.source?.layout
        )

        if (builderManifest) {
          // Transform manifest components
          this.transformTranslator = new SceneTransformTranslator(this.parcelIdentity.land.sceneJsonData.source)

          builderManifest.scene.components = Object.entries(builderManifest.scene.components).reduce(
            (acc, [k, v]) => ({ ...acc, [k]: this.transformTranslator.transformBuilderComponent(v) }),
            {}
          )

          // Notify renderer about the project information
          getUnityInstance().SendBuilderProjectInfo(
            builderManifest.project.title,
            builderManifest.project.description,
            false
          )

          // Update/Create manifest in builder-server
          this.builderManifest = builderManifest
          this.builderApiManager
            .updateProjectManifest(builderManifest, identity)
            .catch((error) => defaultLogger.error(`Error updating project manifest ${error}`))

          // Retrieve deployed thumbnail
          const thumbnailHash: string | undefined = this.parcelIdentity.land.mappingsResponse.contents.find(
            (pair) => pair.file === CONTENT_PATH.SCENE_THUMBNAIL
          )?.hash
          let thumbnail: string = ''
          if (thumbnailHash) {
            const thumbnailBuffer = await contentClient.downloadContent(thumbnailHash, { attempts: 3 })
            thumbnail = thumbnailBuffer.toString('base64')
          }

          // Publish scene
          this.publishSceneState(
            sceneId,
            builderManifest.project.title,
            builderManifest.project.description,
            thumbnail,
            serializedScene
          ).catch((error) => defaultLogger.error(`Error publishing scene ${error}`))

          return serializedScene
        }
      }
    } catch (error) {
      defaultLogger.error(`Failed creating project from state definition at coords ${baseParcel}`, error)
    }
  }

  @exposeMethod
  async sendAssetsToRenderer(state: SerializedSceneState): Promise<string> {
    const assets = await this.getAllBuilderAssets(state)
    getUnityInstance().SendSceneAssets(assets)
    return 'OK'
  }

  private async getAllBuilderAssets(state: SerializedSceneState): Promise<BuilderAsset[]> {
    const assetIds: Set<AssetId> = new Set()
    for (const entity of state.entities) {
      entity.components
        .filter(({ type, value }) => type === CLASS_ID.GLTF_SHAPE && value.assetId)
        .forEach(({ value }) => assetIds.add(value.assetId))
    }
    return this.builderApiManager.getBuilderAssets([...assetIds])
  }

  private getIdentity(): ExplorerIdentity {
    const identity = getCurrentIdentity(store.getState())
    if (!identity) {
      throw new Error('Identity not found when trying to deploy an entity')
    }
    return identity
  }

  private getParcels(): Pointer[] {
    return this.parcelIdentity.land.sceneJsonData.scene.parcels
  }

  private getContentClient(): ContentClient {
    const contentUrl = getFetchContentServer(store.getState())
    return new ContentClient({ contentUrl })
  }

  private getAllAssets(state: SerializedSceneState): Promise<Map<AssetId, Asset>> {
    const assetIds: Set<AssetId> = new Set()
    for (const entity of state.entities) {
      entity.components
        .filter(({ type, value }) => type === CLASS_ID.GLTF_SHAPE && value.assetId)
        .forEach(({ value }) => assetIds.add(value.assetId))
    }
    return this.builderApiManager.getConvertedAssets([...assetIds])
  }

  private async downloadAssetFiles(assets: Map<AssetId, Asset>): Promise<Map<string, Buffer>> {
    // Path to url map
    const allMappings: Map<string, string> = new Map()

    // Gather all mappings together
    for (const asset of assets.values()) {
      asset.mappings.forEach(({ file, hash }) =>
        allMappings.set(`${CONTENT_PATH.MODELS_FOLDER}/${file}`, `${asset.baseUrl}/${hash}`)
      )
    }

    // Download models
    const promises: Promise<[string, Buffer]>[] = Array.from(allMappings.entries()).map<Promise<[string, Buffer]>>(
      async ([path, url]) => {
        const response = await fetch(url)
        const blob = await response.blob()
        const buffer = await blobToBuffer(blob)
        return [path, buffer]
      }
    )

    const result = await Promise.all(promises)
    return new Map(result)
  }

  private async updateProjectDetails(
    sceneState: SerializedSceneState,
    sceneName: string,
    sceneDescription: string,
    thumbnailBlob: Blob
  ) {
    // Deserialize the scene state
    const deserializedSceneState: SceneStateDefinition = deserializeSceneState(sceneState)

    // Convert the scene state to builder scheme format
    const builderManifest = await toBuilderFromStateDefinitionFormat(
      deserializedSceneState,
      this.builderManifest,
      this.builderApiManager,
      this.transformTranslator
    )

    // Update the project info
    builderManifest.project.title = sceneName
    builderManifest.project.description = sceneDescription

    // Update the manifest
    await this.builderApiManager.updateProjectManifest(builderManifest, this.getIdentity())

    // Update the thumbnail
    await this.builderApiManager.updateProjectThumbnail(builderManifest.project.id, thumbnailBlob, this.getIdentity())
  }
}
setAPIName('SceneStateStorageController', SceneStateStorageController)

// eslint-disable-next-line @typescript-eslint/no-var-requires
const toBuffer = require('blob-to-buffer')
export function blobToBuffer(blob: Blob): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    toBuffer(blob, (err: Error, buffer: Buffer) => {
      if (err) reject(err)
      resolve(buffer)
    })
  })
}
