import formidable from 'formidable';
import { UnexpectedError } from 'n8n-workflow';
import { createWriteStream, type WriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';

import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ContentTooLargeError } from '@/errors/response-errors/content-too-large.error';
import { discardBlankFileInputs } from '@/webhooks/webhook-blank-file-inputs';

// formidable reports the status code it considers appropriate on `httpCode`
// (413 for a file or field exceeding a limit, 400 for a request it cannot
// parse). n8n's error classifier reads `httpStatusCode`, not `httpCode`, so
// without this mapping every parse failure surfaces as a generic 500.
const getFormidableHttpCode = (error: unknown): number | undefined => {
	if (typeof error !== 'object' || error === null || !('httpCode' in error)) return undefined;
	const { httpCode } = error;
	return typeof httpCode === 'number' ? httpCode : undefined;
};

const mapFormParseError = (error: unknown): Error => {
	switch (getFormidableHttpCode(error)) {
		case 413:
			return new ContentTooLargeError('The submitted form data exceeds the allowed size.');
		case 400:
			return BadRequestError.wrap('The submitted form data could not be parsed.', error);
		default:
			return error instanceof Error ? error : new Error(String(error));
	}
};

const normalizeFormData = <T>(values: Record<string, T | T[]>) => {
	for (const key in values) {
		const value = values[key];
		if (Array.isArray(value) && value.length === 1) {
			values[key] = value[0];
		}
	}
};

/**
 * Creates a function that parses multipart form data and returns its body with a cleanup callback.
 */
export const createMultiFormDataParser = (maxFormDataSizeInMb: number) => {
	return async function parseMultipartFormData(req: IncomingMessage): Promise<{
		body: {
			data: formidable.Fields;
			files: formidable.Files;
		};
		/** Removes parser-owned files after the webhook or its response stream consumes them. */
		cleanup: () => Promise<void>;
	}> {
		const { encoding } = req;
		const temporaryFilePaths = new Set<string>();
		const temporaryFileClosures = new Map<string, Promise<void>>();
		const temporaryFileStreams = new Set<WriteStream>();
		const pendingParts: Array<Promise<void>> = [];
		let parseFailed = false;

		const form = formidable({
			multiples: true,
			encoding: encoding as formidable.BufferEncoding,
			maxFileSize: maxFormDataSizeInMb * 1024 * 1024,
			// Accept an empty file so that every part is parsed and counted against
			// the limit above, and so that a file the user selected still parses when
			// it holds no bytes. `discardBlankFileInputs` removes the parts that turn
			// out to be file inputs left empty. formidable rejects an empty file by
			// default, and its `minFileSize` default of 1 rejects it again on its own.
			allowEmptyFiles: true,
			minFileSize: 0,
			fileWriteStreamHandler: (file) => {
				if (!file || !('filepath' in file) || typeof file.filepath !== 'string') {
					throw new UnexpectedError('The upload file path is missing.');
				}
				const stream = createWriteStream(file.filepath);
				temporaryFileStreams.add(stream);
				temporaryFileClosures.set(
					file.filepath,
					new Promise<void>((resolve) => {
						stream.once('close', resolve);
					}),
				);
				if (parseFailed) stream.destroy();
				return stream;
			},
		});
		const handlePart = form.onPart.bind(form);
		form.onPart = (part): Promise<void> | void => {
			if (parseFailed) return;
			const pending = Promise.resolve(handlePart(part));
			pendingParts.push(pending);
			return pending;
		};
		form.on('error', () => {
			parseFailed = true;
			for (const stream of temporaryFileStreams) stream.destroy();
		});
		// Track files when they are created so cleanup does not depend on the normalized field map.
		form.on('fileBegin', (_formName, file) => temporaryFilePaths.add(file.filepath));

		const cleanup = async () => {
			await Promise.all(
				[...temporaryFilePaths].map(async (filePath) => {
					try {
						// A pending open can create the path after an early removal.
						await temporaryFileClosures.get(filePath);
						await rm(filePath, { force: true });
					} catch {
						// Cleanup must not change the webhook response.
					}
				}),
			);
		};

		// `parse` returns a promise when it is called without a callback.
		try {
			const [data, parsedFiles] = await form.parse(req);
			const files = await discardBlankFileInputs(parsedFiles);

			normalizeFormData(data);
			normalizeFormData(files);

			return { body: { data, files }, cleanup };
		} catch (error) {
			parseFailed = true;
			// Finish pending part setup before cleanup takes its file snapshot.
			await Promise.allSettled(pendingParts);
			for (const stream of temporaryFileStreams) stream.destroy();
			await cleanup();
			throw mapFormParseError(error);
		}
	};
};
