import * as core from '@actions/core';
import { publish } from './main';

publish().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)));
