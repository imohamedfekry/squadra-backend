import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Hocuspocus } from '@hocuspocus/server';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HttpServer } from 'node:http';
import { parseCookie } from 'cookie';
import * as Y from 'yjs';
import { AccessTokenService } from 'src/common/Global/security/jwt/services/access-token.service';
import { UserRepository } from 'src/common/database/repositories/user/user.repository';
import { ProjectRepository } from 'src/common/database/repositories/project/project.repository';
import { FileRepository } from 'src/common/database/repositories/project/file.repository';
import { StorageService } from '../storage/storage.service';
import { RealtimeEmitService } from '../realtime/core/realtime-emit.service';
import { FILE_EVENTES } from '../realtime/events/files.events';
import {
  COLLABORATION_PATH,
  COLLABORATION_TEXT_FIELD,
  YJS_CONTENT_TYPE,
  parseDocumentName,
} from './collaboration.constants';

export interface CollaborationContext {
  userId: bigint;
  projectId: bigint;
  fileId: bigint;
  storageKey?: string | null;
}

@Injectable()
export class CollaborationService implements OnModuleDestroy {
  private readonly logger = new Logger(CollaborationService.name);

  private hocuspocus?: Hocuspocus<CollaborationContext>;
  private webSocketServer?: WebSocketServer;

  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly userRepository: UserRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly fileRepository: FileRepository,
    private readonly storageService: StorageService,
    private readonly realtimeEmitService: RealtimeEmitService,
  ) {}

  attach(httpServer: HttpServer): void {
    if (this.hocuspocus) {
      return;
    }

    this.hocuspocus = new Hocuspocus<CollaborationContext>({
      debounce: 1000,
      maxDebounce: 5000,
      quiet: true,
      onAuthenticate: async ({ documentName, requestHeaders, token }) => {
        const parsed = parseDocumentName(documentName);
        const headers = requestHeaders as unknown as Record<
          string,
          string | undefined
        >;
        const cookieToken = headers.cookie
          ? parseCookie(headers.cookie).Authorization
          : undefined;
        const accessToken = token || cookieToken;

        if (!parsed || !accessToken) {
          throw new Error('unauthorized');
        }

        const user = await this.authenticateUser(accessToken);
        const project = await this.projectRepository.findById(parsed.projectId);

        if (!project || project.userId !== user.id) {
          throw new Error('unauthorized');
        }

        const file = await this.fileRepository.getFile(parsed.fileId);

        if (!file || file.projectId !== parsed.projectId || file.type !== 'file') {
          throw new Error('unauthorized');
        }

        return {
          userId: user.id,
          projectId: parsed.projectId,
          fileId: parsed.fileId,
          storageKey: file.storageKey,
        };
      },
      onLoadDocument: async ({ document, context }) => {
        if (!context) {
          return document;
        }

        const storageKey =
          context.storageKey ??
          (await this.fileRepository.getFile(context.fileId))?.storageKey;

        if (!storageKey) {
          return document;
        }

        const { buffer, contentType } =
          await this.storageService.getBuffer(storageKey);

        if (buffer.length === 0) {
          return document;
        }

        if (contentType === YJS_CONTENT_TYPE) {
          try {
            Y.applyUpdate(document, buffer);
            return document;
          } catch (error) {
            this.logger.warn(
              `Failed to decode collaborative state for file ${context.fileId}: ${error}`,
            );
          }
        }

        const text = document.getText(COLLABORATION_TEXT_FIELD);

        if (this.isTextContentType(contentType) && text.length === 0) {
          text.insert(0, buffer.toString('utf8'));
        }

        return document;
      },
      onStoreDocument: async ({ document, lastContext, documentName }) => {
        const context =
          lastContext && (lastContext as CollaborationContext).fileId
            ? (lastContext as CollaborationContext)
            : (parseDocumentName(documentName) as CollaborationContext | null);

        if (!context) {
          return;
        }

        const storageKey =
          context.storageKey ??
          (await this.fileRepository.getFile(context.fileId))?.storageKey;

        if (!storageKey) {
          return;
        }

        const update = Buffer.from(Y.encodeStateAsUpdate(document));

        await this.storageService.putBuffer(
          storageKey,
          update,
          YJS_CONTENT_TYPE,
        );

        this.realtimeEmitService.toProject(
          context.projectId.toString(),
          FILE_EVENTES.CONTENT_UPDATED,
          { fileId: context.fileId.toString() },
        );
      },
    });

    this.webSocketServer = new WebSocketServer({
      noServer: true,
    });

    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = (request.url ?? '').split('?')[0];

      if (pathname !== COLLABORATION_PATH) {
        return;
      }

      this.webSocketServer!.handleUpgrade(request, socket, head, (ws) => {
        this.webSocketServer!.emit('connection', ws, request);
      });
    });

    this.webSocketServer.on('connection', (socket, request) =>
      this.handleSocketConnection(socket, request),
    );
  }

  async applyFullText(documentName: string, content: string): Promise<void> {
    if (!this.hocuspocus) {
      throw new Error('Collaboration server is not attached');
    }

    const connection = await this.hocuspocus.openDirectConnection(documentName);

    try {
      await connection.transact((document) => {
        const text = document.getText(COLLABORATION_TEXT_FIELD);
        text.delete(0, text.length);
        text.insert(0, content);
      });
    } finally {
      await connection.disconnect({ unloadImmediately: false });
    }
  }

  async onModuleDestroy() {
    this.webSocketServer?.close();

    if (this.hocuspocus) {
      this.hocuspocus.flushPendingStores();
      this.hocuspocus.closeConnections();

      await Promise.all(
        Array.from(this.hocuspocus.documents.values()).map((document) =>
          this.hocuspocus!.unloadDocument(document),
        ),
      );
    }
  }

  private async authenticateUser(token: string) {
    const payload = await this.accessTokenService.verify<{ sub: string }>(
      token.trim(),
    );

    if (!payload?.sub) {
      throw new Error('unauthorized');
    }

    const user = await this.userRepository.findById(BigInt(payload.sub));

    if (!user) {
      throw new Error('unauthorized');
    }

    return user;
  }

  private handleSocketConnection(socket: WebSocket, request: IncomingMessage) {
    const connection = this.hocuspocus!.handleConnection(
      socket,
      request as unknown as Parameters<Hocuspocus<CollaborationContext>['handleConnection']>[1],
    );

    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        return;
      }

      connection.handleMessage(new Uint8Array(Buffer.from(data as unknown as ArrayBuffer)));
    });

    socket.on('close', (code, reason) => {
      connection.handleClose({ code, reason: reason.toString() });
    });

    socket.on('error', (error) => {
      this.logger.error(`Collaboration socket error: ${error.message}`);
    });
  }

  private isTextContentType(contentType?: string): boolean {
    if (!contentType) {
      return false;
    }

    const normalized = contentType.toLowerCase();

    return (
      normalized.startsWith('text/') ||
      normalized === 'application/json' ||
      normalized === 'application/javascript' ||
      normalized === 'application/xml' ||
      normalized.includes('+json') ||
      normalized.includes('+xml')
    );
  }
}