'use strict'

import Client from './Client'
import { OutgoingMessage } from './Client'

export default class OutgoingSession extends EventTarget {
  public readonly client: Client
  public readonly target: string

  private settled = false

  public constructor (client: Client, target: string) {
    super()
    this.client = client
    this.target = target
  }

  public async cancel (reason?: string): Promise<void> {
    if (this.settled) {
      throw new Error('Request already settled')
    }

    const request: OutgoingMessage = {
      cmd: 'session-cancel',
      uri: this.target
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

    this.settle('canceled')
  }

  public handleAccept (): void {
    if (this.settled) {
      throw new Error('Request already settled')
    }

    const connection = this.client.createPeerConnection(this.target)
    this.settle('accepted', connection)
  }

  public handleReject (reason?: string): void {
    this.settle('rejected', reason)
  }

  public handleTimeout () {
    this.settle('timed-out')
  }

  private settle (type: string, arg?: any) {
    if (this.settled) {
      return
    }

    this.settled = true
    this.dispatchEvent(arg ? new CustomEvent(type, { detail: arg }) : new Event(type))
    this.dispatchEvent(new Event('settled'))
  }
}
