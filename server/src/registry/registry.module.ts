import { Module } from '@nestjs/common';

import { REGISTRY_FILE, RegistryService, defaultRegistryFile } from './registry.service';

/**
 * REGISTRY_FILE is provided explicitly (not left to the @Optional fallback)
 * so e2e suites can .overrideProvider(REGISTRY_FILE) onto a fixture — an
 * un-provided token cannot be overridden.
 */
@Module({
  providers: [RegistryService, { provide: REGISTRY_FILE, useFactory: defaultRegistryFile }],
  exports: [RegistryService]
})
export class RegistryModule {}
