import { fileURLToPath } from 'url'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { getAllBlocks, getAllSchemas, SchemaWithBlocks } from './imports'
import { convertDocumentTextToTrimmedLineArray, getFieldTypesFromCurrentBlock, relativeToAbsolutePath } from './util'

const virtualizeBlockField = (blockText: string, fieldName: string, blockName: string) => {
  return blockText.replace(new RegExp(`(?<=${fieldName}.*)(\\b${blockName}\\b)`, 'gm'), `${blockName}VirtualReplaced`)
}

export const getVirtualSchema = (document: TextDocument) => {
  const documentAbsolutePath = fileURLToPath(document.uri)

  const documentSchema = getAllSchemas().find((schema) => schema.path === documentAbsolutePath)
  if (!documentSchema) {
    return
  }

  const documentSchemaBlockNames = documentSchema.blocks
    .filter((b) => ['enum', 'type', 'model'].includes(b.type))
    .map((b) => b.name)

  // Find direct imports in document schema so we can add
  // them as non-virtualized

  const nonVirtualizableBlockNames: string[] = [...documentSchemaBlockNames]
  const initialBlocksToSearch: [SchemaWithBlocks, string[]][] = []

  const documentSchemaImports = documentSchema.blocks.filter((b) => b.type === 'import')
  for (const documentSchemaImport of documentSchemaImports) {
    if (!documentSchemaImport.relativeImportPath || !documentSchemaImport.importedBlocks?.length) {
      continue
    }

    const importedPath = relativeToAbsolutePath(documentSchema.document, documentSchemaImport.relativeImportPath)
    const foundImportedSchema = getAllSchemas().find((s) => s.path === importedPath + '.prisma')
    if (!foundImportedSchema) {
      continue
    }

    const importedBlockNames = documentSchemaImport.importedBlocks
      .map((b) => b.name)
      .filter((name) => foundImportedSchema.blocks.find((fb) => fb.name === name))

    initialBlocksToSearch.push([foundImportedSchema, importedBlockNames])
    nonVirtualizableBlockNames.push(...importedBlockNames)
  }

  const virtualSchema = ['// begin_virtual_schema\n']
  const visitedBlocks: string[] = [...documentSchemaBlockNames]

  // Find datasource

  const datasourceSchema = getAllSchemas().find((s) => s.blocks.some((b) => b.type === 'datasource'))
  if (datasourceSchema) {
    const dataSourceBlock = datasourceSchema?.blocks.find((b) => b.type === 'datasource')
    if (dataSourceBlock) {
      virtualSchema.push(datasourceSchema.document.getText(dataSourceBlock.range))
    }
  }

  /**
   * Search all blocks in a schema and resolve their
   * fields recursively until all necessary dependencies have been
   * processed
   */
  const searchBlocks = (schema: SchemaWithBlocks, blockNamesToSearch: string[]) => {
    const blocksToSearch = schema.blocks.filter((b) => blockNamesToSearch.includes(b.name))

    if (!blocksToSearch.length) {
      return
    }

    const imports = schema.blocks.filter((b) => b.type === 'import')
    const schemaDocumentLines = convertDocumentTextToTrimmedLineArray(schema.document)

    for (const blockToSearch of blocksToSearch) {
      if (visitedBlocks.includes(blockToSearch.name)) {
        continue
      }

      visitedBlocks.push(blockToSearch.name)

      // Process individual blocks by virtualizing them if required
      // and finding and virtualizing each of their field relations

      let blockText = schema.document.getText(blockToSearch.range)
      if (!nonVirtualizableBlockNames.includes(blockToSearch.name)) {
        blockText = blockText.replace(
          new RegExp(`(?<=${blockToSearch.type} )(${blockToSearch.name})`),
          `${blockToSearch.name}VirtualReplaced`,
        )
      }

      // Go through all fields and recursively search blocks
      // and virtualize them along the way if necessary

      const blockFields = getFieldTypesFromCurrentBlock(schemaDocumentLines, blockToSearch, undefined, true)
      for (const fieldName in blockFields.fieldTypeNames) {
        const fieldType = blockFields.fieldTypeNames[fieldName].replace(/\[\]|\?/g, '')

        if (!getAllBlocks().includes(fieldType)) {
          // Not a relation/block
          continue
        }

        const fieldBlockName = fieldType

        // There are four possible outcomes
        // 1) Block already visited (only rename if necessary)
        // 2) Block in current schema (rename if necessary and visit its fields)
        // 3) Block in imports (find it in imported schema and do 3)

        // 1)
        if (visitedBlocks.includes(fieldBlockName)) {
          if (!nonVirtualizableBlockNames.includes(fieldBlockName)) {
            blockText = virtualizeBlockField(blockText, fieldName, fieldBlockName)
          }

          continue
        }

        // 2)
        const currentSchemaBlockMatch = schema.blocks.find((b) => b.name === fieldBlockName)
        if (currentSchemaBlockMatch) {
          if (!nonVirtualizableBlockNames.includes(fieldBlockName)) {
            blockText = virtualizeBlockField(blockText, fieldName, fieldBlockName)
          }

          searchBlocks(schema, [fieldBlockName])
          continue
        }

        // 3)
        const importBlock = imports.find((i) => i.importedBlocks?.some((ib) => ib.name === fieldBlockName))
        if (importBlock && importBlock.importedBlocks?.length && importBlock.relativeImportPath) {
          const importBlockSchemaPath = relativeToAbsolutePath(schema.document, importBlock.relativeImportPath)
          const importBlockSchema = getAllSchemas().find((s) => s.path === importBlockSchemaPath + '.prisma')

          if (!importBlockSchema) {
            continue
          }

          const foundBlockInImport = importBlockSchema.blocks.find((b) => b.name === fieldBlockName)
          if (!foundBlockInImport) {
            continue
          }

          if (!nonVirtualizableBlockNames.includes(fieldBlockName)) {
            blockText = virtualizeBlockField(blockText, fieldName, fieldBlockName)
          }

          searchBlocks(importBlockSchema, [fieldBlockName])
          continue
        }
      }

      // Once all fields have been processed, this block can be
      // added to the virtual schema

      virtualSchema.push(blockText)
    }
  }

  // Init the search by passing the direct imports of the current
  // schema and let the rest be resolved

  for (const initialBlock of initialBlocksToSearch) {
    searchBlocks(...initialBlock)
  }

  return virtualSchema.join('\n')
}