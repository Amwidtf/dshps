/**
 * dshps — plugin stack root Host half.
 *
 * This row has no Host behavior of its own. Its job is to mount the package so
 * the shared Web client bundle (`./client`) is composed into the page; the
 * `dshp-*` subpath plugins carry the actual Host features.
 */
export function apply() {}

export const name = 'dshps'
