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
    uri?: string,
    message?: string
  },
  body?: {
    candidate?: string,
    codec?: string,
    mid?: string,
    uri?: string,
    offer?: string
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

  private hasSetRemoteOffer: boolean = false;
  private candidates: Array<string> = new Array

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
    return this.connections.get(uri) as PeerConnection
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

  public async subscribeStream(uri: string) {
    if (this.id === uri) {
      throw new Error('Can\'t send a message to yourself')
    } else if (this.connections.has(uri)) {
      throw new Error('Peer connection already established')
    } else if (this.pendingOutgoingSessions.has(uri) || this.pendingIncomingSessions.has(uri)) {
      throw new Error('Session request already active')
    }

    const response = await this.send({
      transaction_id: Date.parse(new Date().toString()) + '',
      cmd: 'create_session'
    })

    if (response.result == 'failed') {
      throw new Error(response.result)
    }

    const incomingSession = new IncomingSession(this, uri)

    // 订阅uri
    if (response.result == 'success') {
      let reqSub = {
        cmd: 'subscribe_stream',
        transaction_id: Date.parse(new Date().toString()) + '',
        session_id: response.response.session_id,
        uri: uri,
        mid: 'video', // 写死video
        codec: 'h264' // 对应车的编码器类型，目前车都是h264，后面车不一定
      }
      this.send(reqSub)
    }

    incomingSession.addEventListener('settled', () => {
      this.pendingIncomingSessions.delete(uri)
    }, { once: true })

    this.pendingIncomingSessions.set(uri, incomingSession)
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

    switch (message.type) {
      case 'publisher_offer':
        this.handlePublishOffer(message)
        return
      case 'sync_candidate':
        this.handleSyncCandidate(message)
        return
    }

    switch (message.cmd) {
      case 'subscribe_stream':
        console.log(message.cmd);
        return
      case 'create_session':
        console.log(message.cmd);
        return
      case 'keepalive':
        console.log(message.cmd);
        return
      case 'sync_candidate':
        console.log(message.cmd);
        return
      case 'answer_stream':
        console.log(message.cmd);
        return
    }
  }

  private handleSyncCandidate(message: IncomingMessage) {
    console.log('sync_candidate');
    console.log(message);
    if (message.body.candidate != 'completed') {
      if (this.candidates.indexOf(message.body.candidate) == -1) {
        this.candidates.push(message.body.candidate);
      }
    }
    if (this.hasSetRemoteOffer) {
      // 设置candidate
      console.log('add candidate');
      console.log(message.body.candidate);
      if (message.body.candidate != 'completed') {
        this.onCandidate(message.body.candidate, message.uri);
      }
    }
  }

  private onCandidate(candidate: string, uri: string) {
    if (candidate) {
      let c = new RTCIceCandidate({
        candidate: candidate,
        sdpMid: 'video',
        sdpMLineIndex: 0
      })
      let connection = this.connections.get(uri)
      connection.raw.addIceCandidate(c)
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

  private handlePublishOffer(message: IncomingMessage) {
    const session = new IncomingSession(this, message.uri)

    session.addEventListener('settled', () => {
      this.pendingIncomingSessions.delete(message.uri)
    }, { once: true })

    this.pendingIncomingSessions.set(message.uri, session)
    this.dispatchEvent(new CustomEvent('session', {
      detail: session
    }))

    let connection = this.connections.get(message.uri)

    if (!connection) {
      connection = this.createPeerConnection(message.uri)
      this.dispatchEvent(new CustomEvent('incoming', {
        detail: connection
      }))

      // 设置remote_offer
      let offer = {
        type: 'offer' as RTCSdpType,
        sdp: message.body.offer
      }
      connection.raw.setRemoteDescription(new RTCSessionDescription(offer)).then(() => {
        this.hasSetRemoteOffer = true;
        for (let i = 0; i < this.candidates.length; i++) {
          console.log('add candidates1');
          console.log(this.candidates[i]);
          this.onCandidate(this.candidates[i], message.uri);
        }
      })

      connection.raw.createAnswer(
        (answer: any) => {
          connection.raw.setLocalDescription(answer);
          console.log('local answer');
          console.log(answer);
          let answerStreamReq = {
            'transaction_id': Date.parse(new Date().toString()) + '',
            'session_id': message.session_id,
            'cmd': 'answer_stream',
            'uri': message.uri,
            'mid': 'video',
            'codec': 'h264',
            'answer': answer.sdp
          }
          this.send(answerStreamReq);
        },
        (error) => {
          alert('oops...error');
        }
      );
    }
  }

  private handleSessionStart(message: IncomingMessage) {
    const session = new IncomingSession(this, message.uri)

    session.addEventListener('settled', () => {
      this.pendingIncomingSessions.delete(message.uri)
    }, { once: true })

    this.pendingIncomingSessions.set(message.uri, session)
    this.dispatchEvent(new CustomEvent('session', {
      detail: session
    }))
  }

  private handleSessionUpdate(message: IncomingMessage) {
    // Check if we're dealing with an incoming session
    if (this.pendingIncomingSessions.has(message.uri)) {
      const session = this.pendingIncomingSessions.get(message.uri)

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
    if (this.pendingOutgoingSessions.has(message.uri)) {
      const session = this.pendingOutgoingSessions.get(message.uri)

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
    // let connection = this.connections.get(message.uri)

    // if (!connection) {
    //   connection = this.createPeerConnection(message.uri)
    //   this.dispatchEvent(new CustomEvent('incoming', {
    //     detail: connection
    //   }))
    // }

    // connection.handleMessage(message)
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
