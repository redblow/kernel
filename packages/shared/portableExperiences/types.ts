import { StorePortableExperience } from 'shared/types'

export type PortableExperiencesState = {
  /** List of denied portable experiences from renderer */
  deniedPortableExperiencesFromRenderer: string[]

  /** List of portable experiences created by scenes */
  portableExperiencesCreatedByScenesList: Record<string, StorePortableExperience>
}

export type RootPortableExperiencesState = {
  portableExperiences: PortableExperiencesState
}
