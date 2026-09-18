import { Module } from '@nestjs/common';

import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { FilesSource } from './sources/files.source';
import { GithubSource } from './sources/github.source';
import { ITEM_SOURCES } from './sources/source';
import { RegistryModule } from '../registry/registry.module';
import { TrackerModule } from '../tracker/tracker.module';

@Module({
  imports: [RegistryModule, TrackerModule],
  controllers: [ItemsController],
  providers: [
    ItemsService,
    FilesSource,
    GithubSource,
    {
      // The registered adapters, as one array behind one token (task-43).
      // Phase 2 (task-45) is the seam's own test, and it passed: registering
      // the GitHub adapter is this factory, its `inject` list and the provider
      // line above — nothing in `items.service.ts` changed to accept it.
      //
      // Order is not significant: the service keys them by `kind` and throws
      // at boot if two claim one.
      provide: ITEM_SOURCES,
      useFactory: (files: FilesSource, github: GithubSource) => [files, github],
      inject: [FilesSource, GithubSource]
    }
  ]
})
export class ItemsModule {}
