import * as core from '@actions/core';
import { downloadArtifact } from './artifact/download';

downloadArtifact().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)));
