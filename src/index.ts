/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Adam Voss. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path'
import { workspace, NotificationType, RequestType, ExtensionContext, RevealOutputChannelOn, Uri, fetch, TransportKind, extensions, LanguageClient, LanguageClientOptions, ServerOptions } from 'coc.nvim'
import { CUSTOM_SCHEMA_REQUEST, CUSTOM_CONTENT_REQUEST, SchemaExtensionAPI } from './schema-extension-api'
import { joinPath } from './paths'

export interface ISchemaAssociations {
  [pattern: string]: string[]
}

export interface ISchemaAssociation {
  fileMatch: string[]
  uri: string
}

namespace SchemaAssociationNotification {
  export const type: NotificationType<ISchemaAssociations | ISchemaAssociation[], any> = new NotificationType(
    'json/schemaAssociations'
  )
}

namespace VSCodeContentRequestRegistration {
  export const type: NotificationType<{}, {}> = new NotificationType('yaml/registerVSCodeContentRequest')
}

namespace VSCodeContentRequest {
  export const type: RequestType<string, string, any, any> = new RequestType('vscode/content')
}

namespace DynamicCustomSchemaRequestRegistration {
  export const type: NotificationType<{}, {}> = new NotificationType('yaml/registerCustomSchemaRequest')
}

let client: LanguageClient

export function activate(context: ExtensionContext): SchemaExtensionAPI {
  // The YAML language server is implemented in node
  const serverModule = context.asAbsolutePath(
    path.join('node_modules', 'yaml-language-server', 'out', 'server', 'src', 'server.js')
  )

  // The debug options for the server
  const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] }

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions },
  }

  // Options to control the language client
  const clientOptions: LanguageClientOptions = {
    // Register the server for on disk and newly created YAML documents
    documentSelector: [{ language: 'yaml' }],
    synchronize: {
      // Synchronize these setting sections with the server
      configurationSection: ['yaml', 'http.proxy', 'http.proxyStrictSSL', 'editor.tabSize', '[yaml]'],
      // Notify the server about file changes to YAML and JSON files contained in the workspace
      fileEvents: [workspace.createFileSystemWatcher('**/*.?(e)y?(a)ml'), workspace.createFileSystemWatcher('**/*.json')],
    },
    revealOutputChannelOn: RevealOutputChannelOn.Never
  }

  // Create the language client and start it
  client = new LanguageClient('yaml', 'YAML Support', serverOptions, clientOptions)
  const disposable = client.start()

  const schemaExtensionAPI = new SchemaExtensionAPI(client)

  // Push the disposable to the context's subscriptions so that the
  // client can be deactivated on extension deactivation
  context.subscriptions.push(disposable)

  client.onReady().then(() => {
    // Send a notification to the server with any YAML schema associations in all extensions
    client.sendNotification(SchemaAssociationNotification.type, getSchemaAssociations())

    // If the extensions change, fire this notification again to pick up on any association changes
    extensions.onDidActiveExtension(() => {
      client.sendNotification(SchemaAssociationNotification.type, getSchemaAssociations())
    })
    extensions.onDidUnloadExtension(() => {
      client.sendNotification(SchemaAssociationNotification.type, getSchemaAssociations())
    })
    // Tell the server that the client is ready to provide custom schema content
    client.sendNotification(DynamicCustomSchemaRequestRegistration.type)
    // Tell the server that the client supports schema requests sent directly to it
    client.sendNotification(VSCodeContentRequestRegistration.type)
    // If the server asks for custom schema content, get it and send it back
    client.onRequest(CUSTOM_SCHEMA_REQUEST, (resource: string) => {
      return schemaExtensionAPI.requestCustomSchema(resource)
    })
    client.onRequest(CUSTOM_CONTENT_REQUEST, (uri: string) => {
      return schemaExtensionAPI.requestCustomSchemaContent(uri)
    })
    client.onRequest(VSCodeContentRequest.type, (uri: string) => {
      return fetch(uri, {
        headers: { 'Accept-Encoding': 'gzip, deflate' }
      }).then(res => {
        if (typeof res === 'string') return res
        if (Buffer.isBuffer(res)) return res.toString()
        return JSON.stringify(res)
      }, err => {
        return Promise.reject(err)
      })
    })
  })

  return schemaExtensionAPI
}

function getSchemaAssociations(): ISchemaAssociation[] {
  const associations: ISchemaAssociation[] = []
  extensions.all.forEach((extension) => {
    const packageJSON = extension.packageJSON
    if (packageJSON && packageJSON.contributes && packageJSON.contributes.yamlValidation) {
      const yamlValidation = packageJSON.contributes.yamlValidation
      if (Array.isArray(yamlValidation)) {
        yamlValidation.forEach((jv) => {
          // eslint-disable-next-line prefer-const
          let { fileMatch, url } = jv
          if (typeof fileMatch === 'string') {
            fileMatch = [fileMatch]
          }
          if (Array.isArray(fileMatch) && typeof url === 'string') {
            let uri: string = url
            if (uri[0] === '.' && uri[1] === '/') {
              uri = joinPath(Uri.file(extension.extensionPath), uri).toString()
            }
            fileMatch = fileMatch.map((fm) => {
              if (fm[0] === '%') {
                fm = fm.replace(/%APP_SETTINGS_HOME%/, '/User')
                fm = fm.replace(/%MACHINE_SETTINGS_HOME%/, '/Machine')
                fm = fm.replace(/%APP_WORKSPACES_HOME%/, '/Workspaces')
              } else if (!fm.match(/^(\w+:\/\/|\/|!)/)) {
                fm = '/' + fm
              }
              return fm
            })
            associations.push({ fileMatch, uri })
          }
        })
      }
    }
  })
  return associations
}
