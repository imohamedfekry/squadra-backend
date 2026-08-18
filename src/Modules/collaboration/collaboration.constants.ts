export const YJS_CONTENT_TYPE = 'application/x-yjs';

export const COLLABORATION_PATH = '/collaboration';

export const COLLABORATION_TEXT_FIELD = 'content';

export const COLLABORATION_DOCUMENT_PATTERN = /^project:(\d+):file:(\d+)$/;

export function parseDocumentName(
  documentName: string,
): { projectId: bigint; fileId: bigint } | null {
  const match = COLLABORATION_DOCUMENT_PATTERN.exec(documentName);

  if (!match) {
    return null;
  }

  return {
    projectId: BigInt(match[1]),
    fileId: BigInt(match[2]),
  };
}

export function buildDocumentName(projectId: bigint, fileId: bigint): string {
  return `project:${projectId.toString()}:file:${fileId.toString()}`;
}
