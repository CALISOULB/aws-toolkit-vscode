/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import { StepFunctions } from 'aws-sdk'
import * as sinon from 'sinon'
import { ToolkitClientBuilder } from '../../../shared/clients/toolkitClientBuilder'
import {
    CONTEXT_VALUE_STATE_MACHINE,
    StateMachineNode,
    StepFunctionsNode,
} from '../../../stepFunctions/explorer/stepFunctionsNodes'
import {
    assertNodeListOnlyContainsErrorNode,
    assertNodeListOnlyContainsPlaceholderNode,
} from '../../utilities/explorerNodeAssertions'
import { asyncGenerator } from '../../utilities/collectionUtils'
import globals from '../../../shared/extensionGlobals'

const FAKE_REGION_CODE = 'someregioncode'
const UNSORTED_TEXT = ['zebra', 'Antelope', 'aardvark', 'elephant']
const SORTED_TEXT = ['aardvark', 'Antelope', 'elephant', 'zebra']

describe('StepFunctionsNode', function () {
    let sandbox: sinon.SinonSandbox
    let testNode: StepFunctionsNode

    // Mocked Step Functions Client returns State Machines for anything listed in stateMachineNames
    let stateMachineNames: string[]

    beforeEach(function () {
        sandbox = sinon.createSandbox()

        stateMachineNames = ['stateMachine1', 'stateMachine2']

        initializeClientBuilders()

        testNode = new StepFunctionsNode(FAKE_REGION_CODE)
    })

    afterEach(function () {
        sandbox.restore()
    })

    it('returns placeholder node if no children are present', async function () {
        stateMachineNames = []

        const childNodes = await testNode.getChildren()

        assertNodeListOnlyContainsPlaceholderNode(childNodes)
    })

    it('has StateMachineNode child nodes', async function () {
        const childNodes = await testNode.getChildren()

        assert.strictEqual(childNodes.length, stateMachineNames.length, 'Unexpected child count')

        childNodes.forEach(node =>
            assert.ok(node instanceof StateMachineNode, 'Expected child node to be StateMachineNode')
        )
    })

    it('has child nodes with State Machine contextValue', async function () {
        const childNodes = await testNode.getChildren()

        childNodes.forEach(node =>
            assert.strictEqual(
                node.contextValue,
                CONTEXT_VALUE_STATE_MACHINE,
                'expected the node to have a State Machine contextValue'
            )
        )
    })

    it('sorts child nodes', async function () {
        stateMachineNames = UNSORTED_TEXT

        const childNodes = await testNode.getChildren()

        const actualChildOrder = childNodes.map(node => node.label)
        assert.deepStrictEqual(actualChildOrder, SORTED_TEXT, 'Unexpected child sort order')
    })

    it('has an error node for a child if an error happens during loading', async function () {
        sandbox.stub(testNode, 'updateChildren').callsFake(() => {
            throw new Error('Update Children error!')
        })

        const childNodes = await testNode.getChildren()
        assertNodeListOnlyContainsErrorNode(childNodes)
    })

    function initializeClientBuilders() {
        const stepFunctionsClient = {
            listStateMachines: sandbox.stub().callsFake(() => {
                return asyncGenerator<StepFunctions.StateMachineListItem>(
                    stateMachineNames.map<StepFunctions.StateMachineListItem>(name => {
                        return {
                            name: name,
                            stateMachineArn: 'arn:aws:states:us-east-1:123412341234:stateMachine:' + name,
                            type: 'STANDARD',
                            creationDate: new globals.clock.Date(),
                        }
                    })
                )
            }),
        }

        const clientBuilder = {
            createStepFunctionsClient: sandbox.stub().returns(stepFunctionsClient),
        }

        globals.toolkitClientBuilder = clientBuilder as any as ToolkitClientBuilder
    }
})
