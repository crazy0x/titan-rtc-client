'use strict'

import Client, { OutgoingMessage } from './Client'
import PeerConnection from './PeerConnection'

export default class IncomingSession extends EventTarget {
  public readonly client: Client
  public readonly origin: string

  private settled = false

  public constructor (client: Client, origin: string) {
    super()
    this.client = client
    this.origin = origin
  }

  public async accept (): Promise<PeerConnection> {
    if (this.settled) {
      throw new Error('Request already settled')
    }

    const response = await this.client.send({
      cmd: 'session-accept',
      uri: this.origin
    })

    if (response.result === 'failed') {
      const err = new Error(response.response.message)
      this.settle('error', err)
      throw err
    }

    return this.client.createPeerConnection(this.origin)
  }

  public async reject (reason?: string): Promise<void> {
    if (this.settled) {
      throw new Error('Request already settled')
    }

    const request: OutgoingMessage = {
      cmd: 'session-reject',
      uri: this.origin
    }

    if (reason) {
      request.response = {
        message: reason
      }
    }

    const response = await this.client.send(request)

    if (response.result === 'failed') {
      const err = new Error(response.response.message)
      this.settle('error', err)
      throw err
    }

    this.settle('rejected')
  }

  public handleCancel (): void {
    this.settle('canceled')
  }

  public handleTimeout (): void {
    this.settle('timed-out')
  }

  private settle (type: string, arg?: any): void {
    if (this.settled) {
      return
    }

    this.settled = true
    this.dispatchEvent(arg ? new CustomEvent(type, { detail: arg }) : new Event(type))
    this.dispatchEvent(new Event('settled'))
  }
}
