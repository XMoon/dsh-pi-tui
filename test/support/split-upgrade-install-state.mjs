/**
 * The exact receipt selector for the U0 side-build-install interruption probe.
 *
 * A current `install.inProgress` flag alone is not enough: the same Supervisor
 * writes it for the old profile bootstrap and for both side installs. The
 * side-new interruption probe must bind to the NEW side install operation,
 * otherwise an early worker kill during the old bootstrap could be accepted as
 * a green side-install qualification.
 *
 * @module split-upgrade-install-state
 */

export const SIDE_NEW_INSTALL_PHASE = 'SIDE_NEW_INSTALL_STARTED'

/** True only while the authoritative receipt names the new side install. */
export function isSideNewInstallInProgress(receipt) {
  return receipt?.phase === SIDE_NEW_INSTALL_PHASE
    && receipt?.install?.inProgress === true
    && receipt?.install?.completedAt === undefined
}

export const BOOTSTRAP_INSTALL_PHASE = 'UPGRADE_BOOTSTRAP_ROOT_CREATED'

/** True while the old profile bootstrap is the active install. */
export function isBootstrapInstallInProgress(receipt) {
  return receipt?.phase === BOOTSTRAP_INSTALL_PHASE
    && receipt?.install?.inProgress === true
    && receipt?.install?.completedAt === undefined
}
