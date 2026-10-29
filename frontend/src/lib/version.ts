/**
 * Application version configuration and release channel metadata.
 */
export const APP_VERSION = "0.1.0-beta.5";
export const APP_STAGE = "Beta";
export const IS_BETA = true;

export interface VersionInfo {
  version: string;
  stage: string;
  isBeta: boolean;
  releaseDate: string;
}

export const CURRENT_RELEASE: VersionInfo = {
  version: APP_VERSION,
  stage: APP_STAGE,
  isBeta: IS_BETA,
  releaseDate: "2026-10-28",
};
