import { call, put, race, select } from 'redux-saga/effects'
import { contains, keysIn } from 'ramda'
import Btc from '@ledgerhq/hw-app-btc'

import { actions, selectors } from 'data'
import * as A from './actions'
import * as C from 'services/AlertService'
import * as S from './selectors'
import * as LockboxService from 'services/LockboxService'

const logLocation = 'components/lockbox/sagas'

export default ({ api, coreSagas }) => {
  // determines if lockbox is setup and routes app accordingly
  const determineLockboxRoute = function*() {
    try {
      const devicesR = yield select(selectors.core.kvStore.lockbox.getDevices)
      const devices = devicesR.getOrElse({})

      keysIn(devices).length
        ? yield put(actions.router.push('/lockbox/dashboard'))
        : yield put(actions.router.push('/lockbox/onboard'))
    } catch (e) {
      yield put(
        actions.logs.logErrorMessage(logLocation, 'determineLockboxRoute', e)
      )
    }
  }
  // saves new device to KvStore
  const saveNewDeviceKvStore = function*(action) {
    try {
      const { deviceName } = action.payload
      yield put(A.saveNewDeviceKvStoreLoading())
      const newDeviceR = yield select(S.getNewDeviceInfo)
      const newDevice = newDeviceR.getOrFail('missing_device')
      const mdAccountsEntry = LockboxService.generateAccountsMDEntry(
        newDevice.info
      )
      // store device in kvStore
      yield put(
        actions.core.kvStore.lockbox.createNewDeviceEntry(
          newDevice.id,
          newDevice.type,
          deviceName,
          mdAccountsEntry
        )
      )
      yield put(A.saveNewDeviceKvStoreSuccess())
      yield put(actions.modals.closeModal())
      yield put(actions.router.push('/lockbox/dashboard'))
      yield put(actions.core.data.bitcoin.fetchData())
      // reset new device setup to step 1
      yield put(A.changeDeviceSetupStep('setup-type'))
      yield put(actions.alerts.displaySuccess(C.LOCKBOX_SETUP_SUCCESS))
    } catch (e) {
      yield put(A.saveNewDeviceKvStoreFailure(e))
      yield put(actions.alerts.displayError(C.LOCKBOX_SETUP_ERROR))
      yield put(actions.logs.logErrorMessage(logLocation, 'storeDeviceName', e))
    }
  }

  const updateDeviceBalanceDisplay = function*(action) {
    try {
      const { deviceID, showBalances } = action.payload
      yield put(A.updateDeviceBalanceDisplayLoading())
      yield put(
        actions.core.kvStore.lockbox.updateDeviceBalanceDisplay(
          deviceID,
          showBalances
        )
      )
      yield put(A.updateDeviceBalanceDisplaySuccess())
      yield put(actions.alerts.displaySuccess(C.LOCKBOX_UPDATE_SUCCESS))
    } catch (e) {
      yield put(A.updateDeviceBalanceDisplayFailure())
      yield put(actions.alerts.displayError(C.LOCKBOX_UPDATE_ERROR))
      yield put(
        actions.logs.logErrorMessage(
          logLocation,
          'updateDeviceBalanceDisplay',
          e
        )
      )
    }
  }

  // renames a device in KvStore
  const updateDeviceName = function*(action) {
    try {
      const { deviceID, deviceName } = action.payload
      yield put(A.updateDeviceNameLoading())
      yield put(
        actions.core.kvStore.lockbox.storeDeviceName(deviceID, deviceName)
      )
      yield put(A.updateDeviceNameSuccess())
      yield put(actions.alerts.displaySuccess(C.LOCKBOX_UPDATE_SUCCESS))
    } catch (e) {
      yield put(A.updateDeviceNameFailure())
      yield put(actions.alerts.displayError(C.LOCKBOX_UPDATE_ERROR))
      yield put(
        actions.logs.logErrorMessage(logLocation, 'updateDeviceName', e)
      )
    }
  }

  // deletes a device from KvStore
  const deleteDevice = function*(action) {
    try {
      const { deviceID } = action.payload
      yield put(A.deleteDeviceLoading())
      yield put(actions.core.kvStore.lockbox.deleteDeviceLockbox(deviceID))
      yield put(actions.router.push('/lockbox'))
      yield put(A.deleteDeviceSuccess())
      yield put(actions.alerts.displaySuccess(C.LOCKBOX_DELETE_SUCCESS))
    } catch (e) {
      yield put(A.deleteDeviceFailure(e))
      yield put(actions.logs.logErrorMessage(logLocation, 'deleteDevice', e))
      yield put(actions.alerts.displayError(C.LOCKBOX_DELETE_ERROR))
    }
  }

  // new device setup saga
  const initializeNewDeviceSetup = function*() {
    try {
      // 25 min timeout for setup
      const setupTimeout = 1500000
      // poll for both Ledger and Blockchain type devices
      const dashboardTransport = yield race({
        LEDGER: yield call(
          LockboxService.pollForAppConnection,
          'LEDGER',
          'DASHBOARD',
          setupTimeout
        ),
        BLOCKCHAIN: call(
          LockboxService.pollForAppConnection,
          'BLOCKCHAIN',
          'DASHBOARD',
          setupTimeout
        )
      })
      // dashboard detected, user has completed setup steps on device
      // determine the deviceType based on which channel returned
      const deviceType = keysIn(dashboardTransport)[0]
      yield put(A.storeTransportObject(dashboardTransport[deviceType]))
      yield put(A.changeDeviceSetupStep('open-btc-app'))
      const btcTransport = yield call(
        LockboxService.pollForAppConnection,
        deviceType,
        'BTC'
      )
      yield put(A.storeTransportObject(btcTransport))
      const btcConnection = new Btc(btcTransport)
      // derive device info such as chaincodes and xpubs
      const newDeviceInfo = yield call(
        LockboxService.derviveDeviceInfo,
        btcConnection
      )
      // derive a unique deviceId hashed from btc xpub
      const newDeviceId = yield call(
        LockboxService.deriveDeviceID,
        newDeviceInfo.btc
      )
      yield put(
        A.setNewDeviceInfo({
          id: newDeviceId,
          info: newDeviceInfo,
          type: deviceType
        })
      )
      const storedDevicesR = yield select(
        selectors.core.kvStore.lockbox.getDevices
      )
      const storedDevices = storedDevicesR.getOrElse({})
      // check if device has already been added
      if (contains(newDeviceId)(keysIn(storedDevices))) {
        yield put(A.changeDeviceSetupStep('duplicate-device'))
      } else {
        yield put(A.changeDeviceSetupStep('name-device'))
      }
    } catch (e) {
      // TODO: handle connection timeouts gracefully..
      window.alert('DEVICE CONNECTION TIMEOUT') // eslint-disable-line
      yield put(
        actions.logs.logErrorMessage(logLocation, 'initializeNewDeviceSetup', e)
      )
    }
  }

  const initializeDashboard = function*() {
    const btcContextR = yield select(
      selectors.core.kvStore.lockbox.getLockboxBtcContext
    )
    const bchContextR = yield select(
      selectors.core.kvStore.lockbox.getLockboxBchContext
    )
    const ethContextR = yield select(
      selectors.core.kvStore.lockbox.getLockboxEthContext
    )
    yield put(
      actions.core.data.bitcoin.fetchTransactions(
        btcContextR.getOrElse(null),
        true
      )
    )
    yield put(
      actions.core.data.ethereum.fetchTransactions(
        ethContextR.getOrElse(null),
        true
      )
    )
    yield put(
      actions.core.data.bch.fetchTransactions(bchContextR.getOrElse(null), true)
    )
  }

  const updateTransactionList = function*() {
    // TODO: onlyShow and filtering
    const btcContextR = yield select(
      selectors.core.kvStore.lockbox.getLockboxBtcContext
    )
    const bchContextR = yield select(
      selectors.core.kvStore.lockbox.getLockboxBchContext
    )
    const ethContextR = yield select(
      selectors.core.kvStore.lockbox.getLockboxEthContext
    )
    yield put(
      actions.core.data.bitcoin.fetchTransactions(
        btcContextR.getOrElse(null),
        false
      )
    )
    yield put(
      actions.core.data.ethereum.fetchTransactions(
        ethContextR.getOrElse(null),
        false
      )
    )
    yield put(
      actions.core.data.bch.fetchTransactions(
        bchContextR.getOrElse(null),
        false
      )
    )
  }
  /**
   * Polls for device connection and application to be opened
   * @param {String} actions.app - Requested application to wait for
   * @param {String} actions.deviceId - Unique device ID
   * @param {Number} [actions.timeout] - Length of time in ms to wait for a connection
   * @returns {Action} Yields device connected action
   * TODO: rename saga and yielded state changes to be more descriptive??
   */
  const connectDevice = function*(actions) {
    try {
      const { app, deviceId, timeout } = actions.payload
      const storedDevicesR = yield select(
        selectors.core.kvStore.lockbox.getDevices
      )
      const storedDevices = storedDevicesR.getOrElse({})
      const deviceType = storedDevices[deviceId].device_type

      // TODO: this should yield multiple state changes for polling component/modal to use and act against
      // 1) device is detected
      // 2) application is opened
      // 3) possible allow authorization?

      yield call(LockboxService.pollForAppConnection, deviceType, app, timeout)
      yield put(A.deviceConnected())
    } catch (e) {
      yield put(actions.logs.logErrorMessage(logLocation, 'connectDevice', e))
    }
  }

  return {
    connectDevice,
    deleteDevice,
    determineLockboxRoute,
    initializeDashboard,
    initializeNewDeviceSetup,
    saveNewDeviceKvStore,
    updateDeviceName,
    updateTransactionList,
    updateDeviceBalanceDisplay
  }
}