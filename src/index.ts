'use strict'

import Client, { IncomingMessage } from './lib/Client'
import IncomingSession from './lib/IncomingSession'
import PeerConnection from './lib/PeerConnection'

/** The client protocol */
export const PROTOCOL = 'titan-protocol'

// Define event types for ease of use
export type DataChannelEvent = CustomEvent<RTCDataChannel>
export type TrackEvent = CustomEvent<{ track: MediaStreamTrack, streams: MediaStream[] }>
export type IncomingSessionEvent = CustomEvent<IncomingSession>
export type IncomingPeerConnectionEvent = CustomEvent<PeerConnection>
export type SessionAcceptedEvent = CustomEvent<PeerConnection>
export type SessionRejectedEvent = CustomEvent<string>
export type SessionCanceledEvent = CustomEvent<string>
export type SocketCloseEvent = CustomEvent<{ code: number, reason: string }>
export type CustomCommandErrorEvent = CustomEvent<Error>

/**
 * Connect to a Signal-Fire server instance.
 * @param url The URL of the Signal-Fire server
 * @param configuration WebRTC configuration
 */
export default async function connect (url: string, configuration: RTCConfiguration = {}): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    function removeListeners () {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
    }

    function onOpen () {
      if (socket.protocol !== PROTOCOL) {
        removeListeners()
        reject(new Error(`Expected protocol to be ${PROTOCOL} but got ${socket.protocol || 'none'}`))
        socket.close(1002)
      }
    }

    function onMessage (ev: MessageEvent) {
      if (typeof ev.data !== 'string') {
        removeListeners()
        reject(new Error('Expected a string'))
        socket.close(1003)
        return
      }

      let message: IncomingMessage

      try {
        message = JSON.parse(ev.data)
      } catch (e) {
        removeListeners()
        reject(new Error('Unable to parse message'))
        socket.close(1003)
        return
      }



      if (message.result !== 'success' && message.result !== 'event' && message.result !== 'failed') {
        removeListeners()
        reject(new Error('Expected \'success\'\'event\'\'failed\' message'))
        socket.close(1008)
        return
      }

      if (message.result === 'success' && !message.transaction_id) {
        removeListeners()
        reject(new Error('Missing Transaction ID'))
        socket.close(1008)
        return
      }

      if (message.result === 'event' && !message.session_id) {
        removeListeners()
        reject(new Error('Missing Session ID'))
        socket.close(1008)
        return
      }

    //   if (message.data.configuration) {
    //     configuration = {
    //       ...configuration,
    //       ...message.data.configuration
    //     }
    //   }

      removeListeners()
      resolve(new Client(message.session_id as string, socket, configuration))
    }

    function onError (ev: ErrorEvent) {
      removeListeners()
      reject(ev.error)
    }

    function onClose (ev: CloseEvent) {
      removeListeners()
      reject(new Error(`Socket closed with code ${ev.code} (${ev.reason || 'no reason'})`))
    }

    const socket = new WebSocket(url, PROTOCOL)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}

export { default as Client, Message, OutgoingMessage, IncomingMessage } from './lib/Client'
export { default as PeerConnection } from './lib/PeerConnection'
export { default as IncomingSession } from './lib/IncomingSession'
export { default as OutgoingSession } from './lib/OutgoingSession'
