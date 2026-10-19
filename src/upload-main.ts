import * as core from '@actions/core';
import { uploadArtifact } from './artifact/upload';

uploadArtifact().catch((error) => core.setFailed(error instanceof Error ? error.message : String(error)));
