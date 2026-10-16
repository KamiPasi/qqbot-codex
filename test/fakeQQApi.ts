import { QQApiError, type SendResult, type UploadResult } from "../src/qq/api.ts";

export const apiError = (code: number, message = "") => new QQApiError({ method: "POST", path: "/x", status: 400, code, message });

/** 记录调用的假 QQApi。errors 里按接口名放的错误，会依次抛给接下来的调用。 */
export class FakeQQApi {
  calls: Array<{ method: string; target: string; body: any }> = [];
  errors = new Map<string, QQApiError[]>();
  #files = 0;

  #record(method: string, target: string, body: object): void {
    this.calls.push({ method, target, body: structuredClone(body) });
    const err = this.errors.get(method)?.shift();
    if (err) throw err;
  }

  async sendC2C(openid: string, body: object): Promise<SendResult> {
    this.#record("sendC2C", openid, body);
    return { id: `msg${this.calls.length}` };
  }

  async sendGroup(groupOpenid: string, body: object): Promise<SendResult> {
    this.#record("sendGroup", groupOpenid, body);
    return { id: `msg${this.calls.length}` };
  }

  async sendChannel(channelId: string, body: object): Promise<SendResult> {
    this.#record("sendChannel", channelId, body);
    return { id: `msg${this.calls.length}` };
  }

  async sendDms(guildId: string, body: object): Promise<SendResult> {
    this.#record("sendDms", guildId, body);
    return { id: `msg${this.calls.length}` };
  }

  async uploadC2CFile(openid: string, body: object): Promise<UploadResult> {
    this.#record("uploadC2CFile", openid, body);
    return { file_uuid: "uuid", file_info: `info${++this.#files}`, ttl: 300 };
  }

  async uploadGroupFile(groupOpenid: string, body: object): Promise<UploadResult> {
    this.#record("uploadGroupFile", groupOpenid, body);
    return { file_uuid: "uuid", file_info: `info${++this.#files}`, ttl: 300 };
  }
}
