/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as child_process from 'child_process'
import * as crossSpawn from 'cross-spawn'
import * as logger from '../logger'
import { Timeout, waitUntil } from './timeoutUtils'

interface RunParameterContext {
    /** Reports an error parsed from the stdin/stdout streams. */
    reportError(err: string | Error): void
    /** Attempts to stop the running process. See {@link ChildProcess.stop}. */
    stop(force?: boolean, signal?: string): void
    /** The active `Timeout` object (if applicable). */
    readonly timeout?: Timeout
    /** The logger being used by the process. */
    readonly logger: logger.Logger
}

export interface ChildProcessOptions {
    /** Sets the logging behavior. False disables all logging. (default: true) */
    logging?: boolean
    /** Controls whether stdout/stderr is collected and returned in the `ChildProcessResult`. (default: true) */
    collect?: boolean
    /** Wait until streams close to resolve the process result. (default: true) */
    waitForStreams?: boolean
    /** Forcefully kill the process on an error. (default: false) */
    useForceStop?: boolean
    /** Rejects the Promise on any error. Can also use a callback for custom errors. (default: false) */
    rejectOnError?: boolean | ((error: Error) => Error)
    /** Rejects the Promise on non-zero exit codes. Can also use a callback for custom errors. (default: false) */
    rejectOnExit?: boolean | ((code: number) => Error)
    /** A `Timeout` token. The running process will be terminated on expiration or cancellation. */
    timeout?: Timeout
    /** Options sent to the `spawn` command. This is merged in with the base options if they exist. */
    spawnOptions?: child_process.SpawnOptions
    /** Callback for intercepting text from the stdout stream. */
    onStdout?: (text: string, context: RunParameterContext) => void
    /** Callback for intercepting text from the stderr stream. */
    onStderr?: (text: string, context: RunParameterContext) => void
}

export interface ChildProcessRunOptions extends ChildProcessOptions {
    /** Arguments applied in addition to the ones used in construction. */
    extraArgs?: string[]
}

export interface ChildProcessResult {
    exitCode: number
    error: Error | undefined
    /** All output emitted by the process, if it was started with `collect=true`, else empty. */
    stdout: string
    /** All stderr data emitted by the process, if it was started with `collect=true`, else empty. */
    stderr: string
    signal?: string
}

/**
 * Convenience class to manage a child process
 * To use:
 * - instantiate
 * - call and await run to get the results (pass or fail)
 */
export class ChildProcess {
    private childProcess: child_process.ChildProcess | undefined
    private processErrors: Error[] = []
    private processResult: ChildProcessResult | undefined
    private log: logger.Logger

    // TODO: we probably should keep track of all spawned processes in the prototype to make sure they are cleaned up

    /** Collects stdout data if the process was started with `collect=true`. */
    private stdoutChunks: string[] = []
    /** Collects stderr data if the process was started with `collect=true`. */
    private stderrChunks: string[] = []

    private makeResult(code: number, signal?: string): ChildProcessResult {
        return {
            exitCode: code,
            stdout: this.stdoutChunks.join().trim(),
            stderr: this.stderrChunks.join().trim(),
            error: this.processErrors[0], // Only use the first since that one usually cascades.
            signal,
        }
    }

    public constructor(
        private readonly command: string,
        private readonly args: string[] = [],
        private readonly options: ChildProcessOptions = {}
    ) {
        // TODO: allow caller to use the various loggers instead of just the single one
        this.log = options.logging ?? true ? logger.getLogger() : logger.getNullLogger()
    }

    // TODO: add a way to create 'base' child process instances without necessarily needing to construct a new one each time
    // this way modules can define default parameters (e.g. `Timeout`) and have all downstream functions use it
    /**
     * Runs the child process. Options passed here are merged with the options passed in during construction.
     * Priority is given to `run` options, overriding the previous value.
     */
    public async run(params: ChildProcessRunOptions = {}): Promise<ChildProcessResult> {
        if (this.childProcess) {
            throw new Error('process already started')
        }

        this.log.info(`Running: ${this.toString()}`)

        const cleanup = () => {
            this.childProcess?.removeAllListeners()
            this.childProcess?.stdout?.removeAllListeners()
            this.childProcess?.stderr?.removeAllListeners()
        }

        const mergedOptions = {
            ...this.options,
            ...params,
            spawnOptions: { ...this.options.spawnOptions, ...params.spawnOptions },
        }
        const { rejectOnError, rejectOnExit, timeout } = mergedOptions
        const args = this.args.concat(mergedOptions.extraArgs ?? [])

        // Defaults
        mergedOptions.collect ??= true
        mergedOptions.waitForStreams ??= true

        return new Promise<ChildProcessResult>((resolve, reject) => {
            const errorHandler = (error: Error, force = mergedOptions.useForceStop) => {
                this.processErrors.push(error)
                if (!this.stopped) {
                    this.stop(force)
                }
                if (rejectOnError) {
                    if (typeof rejectOnError === 'function') {
                        reject(rejectOnError(error))
                    } else {
                        reject(error)
                    }
                }
            }

            const paramsContext: RunParameterContext = {
                timeout,
                logger: this.log,
                stop: this.stop.bind(this),
                reportError: err => errorHandler(err instanceof Error ? err : new Error(err)),
            }

            if (timeout) {
                if (timeout?.completed) {
                    throw new Error('Timeout token was already completed.')
                }

                timeout.timer.catch(err => errorHandler(err, true))
            }

            // Async.
            // See also crossSpawn.spawnSync().
            // Arguments are forwarded[1] to node `child_process` module, see its documentation[2].
            // [1] https://github.com/moxystudio/node-cross-spawn/blob/master/index.js
            // [2] https://nodejs.org/api/child_process.html
            try {
                this.childProcess = crossSpawn.spawn(this.command, args, mergedOptions.spawnOptions)
            } catch (err) {
                return errorHandler(err as Error)
            }

            // Emitted whenever:
            //  1. Process could not be spawned, or
            //  2. Process could not be killed, or
            //  3. Sending a message to the child process failed.
            // https://nodejs.org/api/child_process.html#child_process_class_childprocess
            // We also register error event handlers on the output/error streams in case a lower level library fails
            this.childProcess.on('error', errorHandler)
            this.childProcess.stdout?.on('error', errorHandler)
            this.childProcess.stderr?.on('error', errorHandler)

            this.childProcess.stdout?.on('data', (data: { toString(): string }) => {
                if (mergedOptions.collect) {
                    this.stdoutChunks.push(data.toString())
                }

                mergedOptions.onStdout?.(data.toString(), paramsContext)
            })

            this.childProcess.stderr?.on('data', (data: { toString(): string }) => {
                if (mergedOptions.collect) {
                    this.stderrChunks.push(data.toString())
                }

                mergedOptions.onStderr?.(data.toString(), paramsContext)
            })

            // Emitted when streams are closed.
            // This will not be fired if `waitForStreams` is false
            this.childProcess.once('close', (code, signal) => {
                this.processResult = this.makeResult(code, signal)
                resolve(this.processResult)
            })

            // Emitted when process exits or terminates.
            // https://nodejs.org/api/child_process.html#child_process_class_childprocess
            // - If the process exited, `code` is the final exit code of the process, else null.
            // - If the process terminated because of a signal, `signal` is the name of the signal, else null.
            // - One of `code` or `signal` will always be non-null.
            this.childProcess.once('exit', (code, signal) => {
                this.processResult = this.makeResult(
                    typeof code === 'number' ? code : -1,
                    typeof signal === 'string' ? signal : undefined
                )
                if (code && rejectOnExit) {
                    if (typeof rejectOnExit === 'function') {
                        reject(rejectOnExit(code))
                    } else {
                        reject(new Error(`Command exited with non-zero code: ${code}`))
                    }
                }
                if (mergedOptions.waitForStreams === false) {
                    resolve(this.processResult)
                }
            })
        }).finally(() => cleanup())
    }

    /**
     * Gets the `run()` result after the child process has finished.
     *
     * stdout/stderr will be empty unless the process was started with `collect=true`.
     *
     * @returns `run()` result, or undefined if the process has not yet started or is still running.
     */
    public result(): ChildProcessResult | undefined {
        return this.processResult
    }

    public pid(): number {
        return this.childProcess?.pid ?? -1
    }

    public exitCode(): number {
        return this.childProcess?.exitCode ?? -1
    }

    /**
     * Stops the process.
     *
     * SIGTERM won't kill a terminal process, use SIGHUP instead.
     *
     * @param force  Tries SIGKILL if the process is not stopped after a few seconds.
     * @param signal  Signal to send, defaults to SIGTERM (node default).
     *
     */
    public stop(force: boolean = false, signal?: string): void {
        const child = this.childProcess
        if (!child) {
            return
        }
        const command = this.command
        const pid = this.pid()
        if (!this.stopped) {
            child.kill(signal)

            if (force === true) {
                waitUntil(async () => this.stopped, { timeout: 3000, interval: 200, truthy: true })
                    .then(stopped => {
                        if (!stopped) {
                            child.kill('SIGKILL')
                        }
                    })
                    .catch(e => {
                        this.log.warn(`stop(): SIGKILL failed: pid=${pid} command=${command}`)
                    })
            }
        } else {
            throw new Error('Attempting to kill a process that has already been killed')
        }
    }

    /**
     * Returns true if the process has ended, or false if the process was not
     * started or is still running.
     *
     * "Ended" means any of:
     * - error prevented start, or
     * - streams closed, or
     * - process exited, or
     * - exit-code was set.
     */
    public get stopped(): boolean {
        if (!this.childProcess) {
            return false // Not started yet.
        }
        return !!this.processResult
    }

    public toString(): string {
        const pid = this.pid() > 0 ? `PID ${this.pid()}:` : '(not started)'
        return `${pid} [${this.command} ${this.args.join(' ')}]`
    }
}
