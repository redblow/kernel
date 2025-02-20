import { fork } from 'redux-saga/effects'
import { atlasSaga } from '../atlas/sagas'
import { loadingSaga } from '../loading/sagas'
import { profileSaga } from '../profiles/sagas'
import { rootProtocolSaga } from '../protocol/sagas'
import { rendererSaga } from '../renderer/sagas'
import { metricSaga } from './metricSaga'
import { daoSaga } from '../dao/sagas'
import { metaSaga } from '../meta/sagas'
import { chatSaga } from '../chat/sagas'
import { sessionSaga } from '../session/sagas'
import { friendsSaga } from '../friends/sagas'
import { commsSaga } from '../comms/sagas'
import { socialSaga } from '../social/sagas'
import { catalogsSaga } from '../catalogs/sagas'
import { questsSaga } from '../quests/sagas'
import { portableExperienceSaga } from '../portableExperiences/sagas'
import { wearablesPortableExperienceSaga } from '../wearablesPortableExperience/sagas'
import { sceneEventsSaga } from '../sceneEvents/sagas'

export function createRootSaga() {
  return function* rootSaga() {
    yield fork(metaSaga)
    yield fork(friendsSaga)
    yield fork(sessionSaga)
    yield fork(commsSaga)
    yield fork(catalogsSaga)
    yield fork(profileSaga)
    yield fork(chatSaga)
    yield fork(atlasSaga)
    yield fork(daoSaga)
    yield fork(rootProtocolSaga)
    yield fork(metricSaga)
    yield fork(loadingSaga)
    yield fork(socialSaga)
    yield fork(questsSaga)
    yield fork(rendererSaga)
    yield fork(sceneEventsSaga)
    yield fork(portableExperienceSaga)
    yield fork(wearablesPortableExperienceSaga)
  }
}
