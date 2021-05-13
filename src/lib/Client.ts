'use strict'

import { nanoid } from 'nanoid'

import PeerConnection from './PeerConnection'
import IncomingSession from './IncomingSession'
import OutgoingSession from './OutgoingSession'

export interface Message {
  session_id?: string,
  transaction_id?: string,
  cmd?: string,
  result?: string,
  response?: {
    session_id?: string,
    codec?: string,
    mid?: string,
    uri?: string
  },
  body?: {
    candidate?: string,
    codec?: string,
    mid?: string,
    uri?: string
  },
  codec?: string,
  mid?: string,
  uri?: string,
  answer?: string,
  type?: string,
  candidates?: Array<string>
}

export interface IncomingMessage extends Message { }
export interface OutgoingMessage extends Message { }

export default class Client extends EventTarget {
  public readonly id: string
  public readonly configuration: RTCConfiguration

  private readonly socket: WebSocket
  private readonly connections: Map<string, PeerConnection> = new Map()
  private readonly pendingIncomingSessions: Map<string, IncomingSession> = new Map()
  private readonly pendingOutgoingSessions: Map<string, OutgoingSession> = new Map()
  private readonly pendingResponses: Map<string, (message: IncomingMessage) => void> = new Map()
  private readonly customCommands: Map<string, (message: IncomingMessage) => Promise<void>> = new Map()

  public constructor(id: string, socket: WebSocket, configuration: RTCConfiguration = {}) {
    super()

    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error('Expected an open socket')
    }

    this.id = id

    this.handleSocketMessage = this.handleSocketMessage.bind(this)
    this.handleSocketError = this.handleSocketError.bind(this)
    this.handleSocketClose = this.handleSocketClose.bind(this)

    socket.addEventListener('message', this.handleSocketMessage)
    socket.addEventListener('error', this.handleSocketError)
    socket.addEventListener('close', this.handleSocketClose)

    this.socket = socket
    this.configuration = configuration
  }

  public getConnection(uri: string): PeerConnection {
    return this.connections.get(uri)
  }

  public getConnections(): PeerConnection[] {
    return [...this.connections.values()]
  }

  public async createSession(uri: string): Promise<OutgoingSession> {
    if (this.id === uri) {
      throw new Error('Can\'t send a message to yourself')
    } else if (this.connections.has(uri)) {
      throw new Error('Peer connection already established')
    } else if (this.pendingOutgoingSessions.has(uri) || this.pendingIncomingSessions.has(uri)) {
      throw new Error('Session request already active')
    }

    const response = await this.send({
      cmd: 'session-start',
      uri
    })

    if (response.result == 'failed') {
      throw new Error(response.result)
    }

    const session = new OutgoingSession(this, uri)

    session.addEventListener('settled', () => {
      this.pendingOutgoingSessions.delete(uri)
    }, { once: true })

    this.pendingOutgoingSessions.set(uri, session)
    return session
  }

  public createPeerConnection(uri: string, configuration: RTCConfiguration = {}): PeerConnection {
    if (this.id === uri) {
      throw new Error('Can\'t create a connection with yourself')
    } else if (this.connections.has(uri)) {
      throw new Error('Peer connection already created')
    }

    const raw = new RTCPeerConnection({ ...this.configuration, ...configuration })
    const connection = new PeerConnection(this, uri, raw)

    connection.addEventListener('close', () => {
      this.connections.delete(uri)
    }, { once: true })

    this.connections.set(uri, connection)
    return connection
  }

  public addCommand(cmd: string, fn: (message: IncomingMessage) => Promise<void>) {
    this.customCommands.set(cmd, fn)
  }

  public async send(message: OutgoingMessage): Promise<IncomingMessage> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Socket not open')
    } else if (message.uri && message.uri === this.id) {
      throw new Error('Can\'t send to yourself')
    }

    message.session_id = message.session_id || nanoid()
    return new Promise<IncomingMessage>(resolve => {
      this.pendingResponses.set(message.session_id, resolve)
      this.socket.send(JSON.stringify(message))
    })
  }

  private handleSocketMessage(ev: MessageEvent) {
    if (typeof ev.data !== 'string') {
      this.dispatchEvent(new CustomEvent('error', {
        detail: new Error('Expected a string')
      }))

      return
    }

    let message: IncomingMessage

    try {
      message = JSON.parse(ev.data)
    } catch (e) {
      this.dispatchEvent(new CustomEvent('error', {
        detail: new Error('Unable to parse message')
      }))
      return
    }

    // Handle pending responses
    if (this.pendingResponses.has(message.session_id)) {
      const resolve = this.pendingResponses.get(message.session_id)
      this.pendingResponses.delete(message.session_id)
      resolve(message)
      return
    }

    switch (message.cmd) {
      case 'create_session':
        this.handleSessionStart(message)
        return
      case 'keepalive':
        return
      case 'session-accept':
      case 'session-reject':
      case 'session-cancel':
      case 'session-timeout':
        this.handleSessionUpdate(message)
        return
      case 'ice':
      case 'offer':
      case 'answer':
        this.handlePeerMessage(message)
        return
      default:
        this.handleCustomCommand(message)
        return
    }
  }

  private handleCustomCommand(message: IncomingMessage) {
    const fn = this.customCommands.get(message.cmd)

    if (fn) {
      fn(message).catch(err => {
        this.dispatchEvent(new CustomEvent<Error>('error', {
          detail: err
        }))
      })
    }
  }

  private handleSessionStart(message: IncomingMessage) {
    const session = new IncomingSession(this, message.origin)

    session.addEventListener('settled', () => {
      this.pendingIncomingSessions.delete(message.origin)
    }, { once: true })

    this.pendingIncomingSessions.set(message.origin, session)
    this.dispatchEvent(new CustomEvent('session', {
      detail: session
    }))
  }

  private handleSessionUpdate(message: IncomingMessage) {
    // Check if we're dealing with an incoming session
    if (this.pendingIncomingSessions.has(message.origin)) {
      const session = this.pendingIncomingSessions.get(message.origin)

      switch (message.cmd) {
        case 'session-cancel':
          session.handleCancel()
          break
        case 'session-timeout':
          session.handleTimeout()
          break
      }

      return
    }

    // Check if we're dealing with an outgoing session
    if (this.pendingOutgoingSessions.has(message.origin)) {
      const session = this.pendingOutgoingSessions.get(message.origin)

      switch (message.cmd) {
        case 'session-accept':
          session.handleAccept()
          break
        case 'session-reject':
          session.handleReject()
          break
        case 'session-timeout':
          session.handleTimeout()
          break
      }
    }
  }

  private handlePeerMessage(message: IncomingMessage) {
    let connection = this.connections.get(message.origin)

    if (!connection) {
      connection = this.createPeerConnection(message.origin)
      this.dispatchEvent(new CustomEvent('incoming', {
        detail: connection
      }))
    }

    connection.handleMessage(message)
  }

  private handleSocketError(ev: ErrorEvent) {
    this.dispatchEvent(new CustomEvent('error', {
      detail: ev.error
    }))
  }

  private handleSocketClose(ev: CloseEvent) {
    this.socket.removeEventListener('message', this.handleSocketMessage)
    this.socket.removeEventListener('error', this.handleSocketError)
    this.socket.removeEventListener('close', this.handleSocketClose)

    this.dispatchEvent(new CustomEvent('close', {
      detail: {
        code: ev.code,
        reason: ev.reason
      }
    }))
  }
}
