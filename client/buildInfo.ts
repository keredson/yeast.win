import type { BuildInfo } from '../shared/buildInfo.ts';

declare const __YEAST_BUILD_INFO__: BuildInfo;

export const clientBuildInfo = __YEAST_BUILD_INFO__;
