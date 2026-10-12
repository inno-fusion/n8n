import express from 'express';
import nock from 'nock';
import fs, { createWriteStream } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import type { Server, IncomingMessage } from 'node:http';
import { createServer } from 'node:http';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ContentTooLargeError } from '@/errors/response-errors/content-too-large.error';
import { rawBodyReader } from '@/middlewares';

import { createMultiFormDataParser } from '../webhook-form-data';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return { ...actual, rm: vi.fn(actual.rm) };
});

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

/** Test server for testing the form data parsing */
class TestServer {
	agent: TestAgent;

	private app: express.Application;

	private server: Server;

	private testFn: (req: IncomingMessage) => Promise<void> = async () => {};

	private hasBeenCalled = false;

	private failure?: Error;

	constructor() {
		this.app = express();
		// rawBodyReader is required to parse the encoding of the incoming request
		this.app.use(rawBodyReader, async (req, res) => {
			try {
				this.hasBeenCalled = true;

				await this.testFn(req);
			} catch (error) {
				// Express does not forward a rejected async handler, so keep the
				// failure and rethrow it from `assertHasBeenCalled`.
				this.failure = error instanceof Error ? error : new Error(String(error));
			} finally {
				res.end('done');
			}
		});

		this.server = createServer(this.app);
		this.agent = request.agent(this.app);
	}

	assertHasBeenCalled() {
		if (this.failure) throw this.failure;
		expect(this.hasBeenCalled).toBeTruthy();
	}

	reset() {
		this.testFn = async () => {};
		this.hasBeenCalled = false;
		this.failure = undefined;
	}

	sendRequestToHandler(handlerFn: (req: IncomingMessage) => Promise<void>) {
		this.testFn = handlerFn;

		return this.agent.post('/');
	}

	start() {
		this.server.listen(0);
	}

	async stop() {
		await new Promise((resolve) => this.server.close(resolve));
	}
}

describe('webhook-form-data', () => {
	describe('createMultiFormDataParser', () => {
		const oneKbData = Buffer.from('1'.repeat(1024));
		const testServer = new TestServer();
		const rmMock = vi.mocked(rm);
		const cleanupFunctions: Array<() => Promise<void>> = [];
		const parseWithCleanup = async (
			parseFn: ReturnType<typeof createMultiFormDataParser>,
			req: IncomingMessage,
		) => {
			const { body, cleanup } = await parseFn(req);
			cleanupFunctions.push(cleanup);
			return body;
		};

		beforeAll(() => {
			nock.enableNetConnect('127.0.0.1');

			testServer.start();
		});

		beforeEach(() => {
			rmMock.mockClear();
		});

		afterEach(async () => {
			await Promise.all(cleanupFunctions.splice(0).map(async (cleanup) => await cleanup()));
			testServer.reset();
		});

		afterAll(async () => {
			await testServer.stop();
		});

		it('should parse fields from the multipart form data', async () => {
			const parseFn = createMultiFormDataParser(1);

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					expect(parsedData).toStrictEqual({
						data: {
							foo: 'bar',
						},
						files: {},
					});
				})
				.field('foo', 'bar')
				.expect(200);

			testServer.assertHasBeenCalled();
		});

		it('should parse text/plain file from the multipart form data', async () => {
			const parseFn = createMultiFormDataParser(1);

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					expect(parsedData).toStrictEqual({
						data: {
							filename: 'file.txt',
						},
						files: {
							file: expect.objectContaining({
								originalFilename: 'file.txt',
								size: oneKbData.length,
								mimetype: 'text/plain',
							}),
						},
					});
				})
				.attach('file', oneKbData, 'file.txt')
				.field('filename', 'file.txt');

			testServer.assertHasBeenCalled();
		});

		it('should parse multiple files and fields from the multipart form data', async () => {
			const parseFn = createMultiFormDataParser(1);

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					expect(parsedData).toStrictEqual({
						data: {
							file1: 'file.txt',
							file2: 'file.bin',
						},
						files: {
							txt_file: expect.objectContaining({
								originalFilename: 'file.txt',
								size: oneKbData.length,
								mimetype: 'text/plain',
							}),
							bin_file: expect.objectContaining({
								originalFilename: 'file.bin',
								size: oneKbData.length,
								mimetype: 'application/octet-stream',
							}),
						},
					});
				})
				.attach('txt_file', oneKbData, 'file.txt')
				.attach('bin_file', oneKbData, 'file.bin')
				.field('file1', 'file.txt')
				.field('file2', 'file.bin');

			testServer.assertHasBeenCalled();
		});

		it('should reject with a 413 error when a single file exceeds the limit', async () => {
			const oneByteInMb = 1 / 1024 / 1024;
			const parseFn = createMultiFormDataParser(oneByteInMb);

			await testServer
				.sendRequestToHandler(async (req) => {
					const rejection = parseFn(req);
					await expect(rejection).rejects.toBeInstanceOf(ContentTooLargeError);
					await expect(rejection).rejects.toMatchObject({ httpStatusCode: 413 });
				})
				.attach('file', oneKbData, 'file.txt');

			testServer.assertHasBeenCalled();
			expect(rmMock).toHaveBeenCalledExactlyOnceWith(expect.any(String), { force: true });

			const [filePath] = rmMock.mock.calls[0] ?? [];
			if (filePath === undefined) throw new Error('Expected a temporary file to be removed');
			await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
		});

		it('removes rejected upload files after a delayed stream open', async () => {
			const { createWriteStream: createActualWriteStream } =
				await vi.importActual<typeof import('node:fs')>('node:fs');
			const { rm: remove } =
				await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
			let filePath: fs.PathLike | undefined;
			let closed: Promise<void> | undefined;
			const streamSpy = vi.mocked(createWriteStream).mockImplementation((uploadPath, options) => {
				filePath = uploadPath;
				const stream = createActualWriteStream(uploadPath, {
					...(typeof options === 'object' ? options : {}),
					fs: {
						open: (...args: Parameters<typeof fs.open>) => {
							setTimeout(() => fs.open(...args), 30);
						},
						write: fs.write,
						close: fs.close,
					},
				});
				closed = new Promise<void>((resolve) => stream.once('close', resolve));
				return stream;
			});
			try {
				const parseFn = createMultiFormDataParser(1 / 1024 / 1024);
				await testServer
					.sendRequestToHandler(async (req) => {
						await expect(parseFn(req)).rejects.toMatchObject({ httpStatusCode: 413 });
					})
					.attach('file', oneKbData, 'delayed.txt');
				testServer.assertHasBeenCalled();
				if (filePath === undefined || closed === undefined)
					throw new Error('Expected an upload stream');
				await closed;
				expect(rmMock).toHaveBeenCalledExactlyOnceWith(filePath, { force: true });
				await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
			} finally {
				streamSpy.mockImplementation(createActualWriteStream);
				await closed;
				if (filePath !== undefined) await remove(filePath, { force: true });
			}
		});

		it.each([0, 30])(
			'closes every file on a multi-file rejection with a %i ms open delay',
			async (delay) => {
				const { createWriteStream: createActualWriteStream } =
					await vi.importActual<typeof import('node:fs')>('node:fs');
				const { rm: remove } =
					await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
				const uploads: Array<{ path: fs.PathLike; stream: fs.WriteStream; closed: Promise<void> }> =
					[];
				const streamSpy = vi.mocked(createWriteStream).mockImplementation((uploadPath, options) => {
					const stream = createActualWriteStream(uploadPath, {
						...(typeof options === 'object' ? options : {}),
						fs: {
							open: (...args: Parameters<typeof fs.open>) => {
								if (delay) setTimeout(() => fs.open(...args), delay);
								else fs.open(...args);
							},
							write: fs.write,
							close: fs.close,
						},
					});
					uploads.push({
						path: uploadPath,
						stream,
						closed: new Promise<void>((resolve) => stream.once('close', resolve)),
					});
					return stream;
				});
				try {
					const boundary = 'multiFileRejectionBoundary';
					const body = ['first', 'second', 'third']
						.flatMap((name) => [
							`--${boundary}`,
							`Content-Disposition: form-data; name="${name}"; filename="${name}.txt"`,
							'Content-Type: text/plain',
							'',
							'x'.repeat(1024),
						])
						.concat([`--${boundary}--`, ''])
						.join('\r\n');
					const parseFn = createMultiFormDataParser(1 / 1024 / 1024);
					await testServer
						.sendRequestToHandler(async (req) => {
							const rejection = parseFn(req);
							let timer: ReturnType<typeof setTimeout> | undefined;
							try {
								const deadline = new Promise<never>((_, reject) => {
									timer = setTimeout(
										() => reject(new Error('Multipart rejection did not settle')),
										1000,
									);
								});
								await expect(Promise.race([rejection, deadline])).rejects.toMatchObject({
									httpStatusCode: 413,
								});
								expect(uploads.length).toBeGreaterThan(0);
								for (const { stream } of uploads) expect(stream.closed).toBe(true);
							} finally {
								clearTimeout(timer);
								for (const { stream } of uploads) stream.destroy();
								await rejection.catch(() => {});
							}
						})
						.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
						.send(body);
					testServer.assertHasBeenCalled();
					expect(uploads.length).toBeGreaterThan(0);
					await Promise.all(uploads.map(async ({ closed }) => await closed));
					for (const { path, stream } of uploads) {
						expect(stream.closed).toBe(true);
						await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
					}
				} finally {
					streamSpy.mockImplementation(createActualWriteStream);
					await Promise.all(
						uploads.map(async ({ path, stream, closed }) => {
							stream.destroy();
							await closed;
							await remove(path, { force: true });
						}),
					);
				}
			},
		);

		it('closes a stream created while the request fails', async () => {
			const { createWriteStream: createActualWriteStream } =
				await vi.importActual<typeof import('node:fs')>('node:fs');
			const { rm: remove } =
				await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
			const requestError = new Error('Request failed during file setup');
			const uploads: Array<{ path: fs.PathLike; stream: fs.WriteStream; closed: Promise<void> }> =
				[];
			let streamSpy = vi.mocked(createWriteStream);
			try {
				await testServer
					.sendRequestToHandler(async (req) => {
						streamSpy = vi.mocked(createWriteStream).mockImplementation((uploadPath, options) => {
							const stream = createActualWriteStream(uploadPath, options);
							uploads.push({
								path: uploadPath,
								stream,
								closed: new Promise<void>((resolve) => stream.once('close', resolve)),
							});
							req.emit('error', requestError);
							return stream;
						});
						const rejection = createMultiFormDataParser(1)(req);
						let timer: ReturnType<typeof setTimeout> | undefined;
						try {
							const deadline = new Promise<never>((_, reject) => {
								timer = setTimeout(
									() => reject(new Error('Multipart rejection did not settle')),
									1000,
								);
							});
							await expect(Promise.race([rejection, deadline])).rejects.toBe(requestError);
							expect(uploads).toHaveLength(1);
							for (const { path, stream } of uploads) {
								expect(stream.closed).toBe(true);
								await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
							}
						} finally {
							clearTimeout(timer);
							for (const { stream } of uploads) stream.destroy();
							await rejection.catch(() => {});
						}
					})
					.attach('file', oneKbData, 'file.txt');
				testServer.assertHasBeenCalled();
			} finally {
				streamSpy.mockImplementation(createActualWriteStream);
				await Promise.all(
					uploads.map(async ({ path, stream, closed }) => {
						stream.destroy();
						await closed;
						await remove(path, { force: true });
					}),
				);
			}
		});

		it('should reject with a 413 error when the total upload size exceeds the limit', async () => {
			const twoKbData = Buffer.alloc(2 * 1024, 'x');
			const oneKbInMb = 1 / 1024;
			const parseFn = createMultiFormDataParser(oneKbInMb);

			await testServer
				.sendRequestToHandler(async (req) => {
					const rejection = parseFn(req);
					await expect(rejection).rejects.toBeInstanceOf(ContentTooLargeError);
					await expect(rejection).rejects.toMatchObject({ httpStatusCode: 413 });
				})
				.attach('file', twoKbData, 'large-upload.bin');

			testServer.assertHasBeenCalled();
		});

		it('should skip a file input the user left empty', async () => {
			const parseFn = createMultiFormDataParser(1);
			// A browser sends an unselected file input as a 0-byte part with an
			// empty filename. supertest cannot express that, so build the body by hand.
			const boundary = 'emptyFileBoundary';
			const body = [
				`--${boundary}`,
				'Content-Disposition: form-data; name="comment"',
				'',
				'no file attached',
				`--${boundary}`,
				'Content-Disposition: form-data; name="file"; filename=""',
				'Content-Type: application/octet-stream',
				'',
				'',
				`--${boundary}--`,
				'',
			].join('\r\n');

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					expect(parsedData).toStrictEqual({
						data: {
							comment: 'no file attached',
						},
						files: {},
					});
				})
				.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
				.send(body)
				.expect(200);

			testServer.assertHasBeenCalled();
		});

		it('should keep the filled entries when one field repeats with a blank input', async () => {
			const parseFn = createMultiFormDataParser(1);
			const boundary = 'repeatedFieldBoundary';
			const body = [
				`--${boundary}`,
				'Content-Disposition: form-data; name="attachments"; filename="file.txt"',
				'Content-Type: text/plain',
				'',
				'hello',
				`--${boundary}`,
				'Content-Disposition: form-data; name="attachments"; filename=""',
				'Content-Type: application/octet-stream',
				'',
				'',
				`--${boundary}--`,
				'',
			].join('\r\n');

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					// One entry remains, so `normalizeFormData` unwraps the array.
					expect(parsedData).toStrictEqual({
						data: {},
						files: {
							attachments: expect.objectContaining({
								originalFilename: 'file.txt',
								size: 'hello'.length,
							}),
						},
					});
				})
				.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
				.send(body)
				.expect(200);

			testServer.assertHasBeenCalled();
		});

		it('should count an empty-filename part against the size limit', async () => {
			const oneKbInMb = 1 / 1024;
			const parseFn = createMultiFormDataParser(oneKbInMb);
			const boundary = 'oversizedEmptyNameBoundary';
			// The part declares no filename, so it is a candidate for removal, but
			// its content must still meet the limit. Removal happens after
			// formidable has accounted for the bytes, never instead of it.
			const body = [
				`--${boundary}`,
				'Content-Disposition: form-data; name="oversized"; filename=""',
				'Content-Type: application/octet-stream',
				'',
				'x'.repeat(64 * 1024),
				`--${boundary}--`,
				'',
			].join('\r\n');

			await testServer
				.sendRequestToHandler(async (req) => {
					const rejection = parseFn(req);
					await expect(rejection).rejects.toBeInstanceOf(ContentTooLargeError);
					await expect(rejection).rejects.toMatchObject({ httpStatusCode: 413 });
				})
				.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
				.send(body);

			testServer.assertHasBeenCalled();
		});

		it('should keep a file part that omits the filename', async () => {
			const parseFn = createMultiFormDataParser(1);

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					expect(parsedData).toStrictEqual({
						data: {},
						files: {
							file: expect.objectContaining({
								originalFilename: null,
								size: oneKbData.length,
								mimetype: 'application/octet-stream',
							}),
						},
					});
				})
				// supertest omits the filename attribute when `attach` gets no
				// filename, which is how non-browser clients upload content too.
				.attach('file', oneKbData)
				.expect(200);

			testServer.assertHasBeenCalled();
		});

		it('should keep only the file inputs the user filled in', async () => {
			const parseFn = createMultiFormDataParser(1);
			const boundary = 'mixedFileBoundary';
			const body = [
				`--${boundary}`,
				'Content-Disposition: form-data; name="empty_input"; filename=""',
				'Content-Type: application/octet-stream',
				'',
				'',
				`--${boundary}`,
				'Content-Disposition: form-data; name="filled_input"; filename="file.txt"',
				'Content-Type: text/plain',
				'',
				'hello',
				`--${boundary}--`,
				'',
			].join('\r\n');

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					expect(parsedData).toStrictEqual({
						data: {},
						files: {
							filled_input: expect.objectContaining({
								originalFilename: 'file.txt',
								size: 'hello'.length,
								mimetype: 'text/plain',
							}),
						},
					});
				})
				.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
				.send(body)
				.expect(200);

			testServer.assertHasBeenCalled();
		});

		it('should parse a selected file that holds no bytes', async () => {
			const parseFn = createMultiFormDataParser(1);

			await testServer
				.sendRequestToHandler(async (req) => {
					const parsedData = await parseWithCleanup(parseFn, req);

					expect(parsedData).toStrictEqual({
						data: {},
						files: {
							file: expect.objectContaining({
								originalFilename: 'empty.txt',
								size: 0,
							}),
						},
					});
				})
				.attach('file', Buffer.alloc(0), 'empty.txt')
				.expect(200);

			testServer.assertHasBeenCalled();
		});

		it('should reject with a 400 error when the multipart body is malformed', async () => {
			const parseFn = createMultiFormDataParser(1);
			const boundary = 'malformedBoundary';
			// The body ends before the closing boundary, so the parser cannot finish.
			const body = [`--${boundary}`, 'Content-Disposition: form-data; name="foo"', '', 'bar'].join(
				'\r\n',
			);

			await testServer
				.sendRequestToHandler(async (req) => {
					const rejection = parseFn(req);
					await expect(rejection).rejects.toBeInstanceOf(BadRequestError);
					await expect(rejection).rejects.toMatchObject({ httpStatusCode: 400 });
				})
				.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
				.send(body);

			testServer.assertHasBeenCalled();
		});

		it('should reject with the original error when formidable reports another status', async () => {
			const parseFn = createMultiFormDataParser(1);
			const boundary = 'unknownEncodingBoundary';
			// formidable answers an unsupported transfer-encoding with a 501, which
			// is neither a 400 nor a 413 and must not be relabelled as one.
			const body = [
				`--${boundary}`,
				'Content-Disposition: form-data; name="file"; filename="file.txt"',
				'Content-Type: text/plain',
				'Content-Transfer-Encoding: uuencode',
				'',
				'hello',
				`--${boundary}--`,
				'',
			].join('\r\n');

			await testServer
				.sendRequestToHandler(async (req) => {
					const rejection = parseFn(req);
					await expect(rejection).rejects.toThrow('unknown transfer-encoding');
					// The 501 proves the parse reached neither mapped status.
					await expect(rejection).rejects.toMatchObject({ httpCode: 501 });
					await expect(rejection).rejects.not.toBeInstanceOf(BadRequestError);
					await expect(rejection).rejects.not.toBeInstanceOf(ContentTooLargeError);
				})
				.set('Content-Type', `multipart/form-data; boundary=${boundary}`)
				.send(body);

			testServer.assertHasBeenCalled();
		});
	});
});
