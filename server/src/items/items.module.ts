import { Module } from '@nestjs/common';

import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { FilesSource } from './sources/files.source';
import { ITEM_SOURCES } from './sources/source';
import { RegistryModule } from '../registry/registry.module';

@Module({
  imports: [RegistryModule],
  controllers: [ItemsController],
  providers: [
    ItemsService,
    FilesSource,
    {
      // The registered adapters, as one array behind one token (task-43).
      // Phase 2 appends its adapter to this factory and to its `inject` list;
      // nothing else in this module and nothing at all in the service changes
      // then — which is the whole point of the seam.
      provide: ITEM_SOURCES,
      useFactory: (files: FilesSource) => [files],
      inject: [FilesSource]
    }
  ]
})
export class ItemsModule {}
