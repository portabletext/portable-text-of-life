import {
  ChildPath,
  defineSchema,
  Editor,
  EditorProvider,
  EditorSelector,
  keyGenerator,
  PortableTextChild,
  PortableTextEditable,
  useEditor,
  type BlockChildRenderProps,
} from '@portabletext/editor'
import {
  BehaviorAction,
  defineBehavior,
  effect,
  raise,
} from '@portabletext/editor/behaviors'
import {BehaviorPlugin} from '@portabletext/editor/plugins'
import {
  getFocusInlineObject,
  getPreviousInlineObject,
  getSelectedValue,
} from '@portabletext/editor/selectors'
import {isTextBlock} from '@portabletext/editor/utils'
import {defineInputRule, InputRulePlugin} from '@portabletext/plugin-input-rule'
import {useActorRef} from '@xstate/react'
import {useMemo} from 'react'
import {fromCallback, setup} from 'xstate'

export function PortableTextOfLife() {
  return (
    <EditorProvider
      initialConfig={{
        // Initiate the editor with 16 blocks
        initialValue: Array.from({length: 16}, () => ({
          _key: keyGenerator(),
          _type: 'block',
          // Each with 16 cells with a random `alive` state
          children: Array.from({length: 16}, () => ({
            _key: keyGenerator(),
            _type: 'cell',
            alive: Math.random() < 0.5,
          })),
        })),
        schemaDefinition: defineSchema({
          inlineObjects: [
            {name: 'cell', fields: [{name: 'alive', type: 'boolean'}]},
          ],
        }),
      }}
    >
      <PortableTextEditable
        autoFocus
        className="world"
        renderChild={renderChild}
      />
      <LifePlugin />
    </EditorProvider>
  )
}

function renderChild(props: BlockChildRenderProps) {
  if (isCellInlineObject(props.value)) {
    return (
      <span data-selected={props.selected}>
        {props.value.alive ? '●' : '○'}
      </span>
    )
  }

  return props.children
}

type CellInlineObject = {
  _type: 'cell'
  _key: string
  alive: boolean
}

function isCellInlineObject(
  child: PortableTextChild,
): child is CellInlineObject {
  return child._type === 'cell'
}

// Custom Selector to get all cells in the editor
const getCells: EditorSelector<
  Array<{
    node: CellInlineObject
    path: ChildPath
  }>
> = (snapshot) => {
  return snapshot.context.value.flatMap((block) => {
    if (!isTextBlock(snapshot.context, block)) {
      return []
    }

    return block.children.flatMap((child) => {
      if (!isCellInlineObject(child)) {
        return []
      }

      return {
        node: child,
        path: [
          {_key: block._key},
          'children',
          {_key: child._key},
        ] satisfies ChildPath,
      }
    })
  })
}

/**
 * Sets up a heartbeat as well as a few Behaviors to allow you to interact with
 * the game.
 */
function LifePlugin() {
  const editor = useEditor()
  const actorRef = useActorRef(heartbeatMachine, {input: {editor}})
  const inputRules = useMemo(
    () => [
      // Type "stop" to stop the game
      defineInputRule({
        on: /stop/,
        actions: [
          ({event}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            effect(() => {
              actorRef.send({type: 'stop'})
            }),
          ],
        ],
      }),

      // Type "start" to start the game
      defineInputRule({
        on: /start/,
        actions: [
          ({event}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            effect(() => {
              actorRef.send({type: 'start'})
            }),
          ],
        ],
      }),

      // Type "random" to set the cells to a random state
      defineInputRule({
        on: /random/,
        guard: ({snapshot}) => {
          return {cells: getCells(snapshot)}
        },
        actions: [
          ({event}, {cells}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            ...cells.map((cell) =>
              raise({
                type: 'child.set',
                at: cell.path,
                props: {alive: Math.random() < 0.5},
              }),
            ),
          ],
        ],
      }),

      // Type "reset" to set the cells to a dead state
      defineInputRule({
        on: /reset/,
        guard: ({snapshot}) => {
          return {cells: getCells(snapshot)}
        },
        actions: [
          ({event}, {cells}) => [
            ...event.matches.map((match) =>
              raise({
                type: 'delete',
                at: match.targetOffsets,
              }),
            ),
            ...cells.map((cell) =>
              raise({
                type: 'child.set',
                at: cell.path,
                props: {alive: false},
              }),
            ),
          ],
        ],
      }),
    ],
    [actorRef, editor],
  )

  return (
    <>
      <div>
        <p>
          Type <em>stop</em>, <em>start</em>, <em>reset</em> or <em>random</em>{' '}
          to control the game.
        </p>
        <p>
          Click on cells or press <kbd>SPACE</kbd> to flip the state of all
          selected cells.
        </p>
      </div>
      <InputRulePlugin rules={inputRules} />
      <BehaviorPlugin
        behaviors={[
          /**
           * When clicking, flip the state of the nearest cell.
           */
          defineBehavior({
            on: 'mouse.click',
            guard: ({snapshot, event}) => {
              let focusInlineObject = getFocusInlineObject({
                ...snapshot,
                context: {
                  ...snapshot.context,
                  selection: event.position.selection,
                },
              })

              if (!focusInlineObject) {
                // We probably hit an empty span. Let's find the previous
                // inline object.
                focusInlineObject = getPreviousInlineObject({
                  ...snapshot,
                  context: {
                    ...snapshot.context,
                    selection: event.position.selection,
                  },
                })
              }

              if (
                !focusInlineObject ||
                !isCellInlineObject(focusInlineObject.node)
              ) {
                return false
              }

              return {focusInlineObject}
            },
            actions: [
              (_, {focusInlineObject}) => [
                // Flip the state of the cell
                raise({
                  type: 'child.set',
                  at: focusInlineObject.path,
                  props: {
                    alive: !focusInlineObject.node.alive,
                  },
                }),
                // And select it
                raise({
                  type: 'select',
                  at: {
                    anchor: {
                      path: focusInlineObject.path,
                      offset: 0,
                    },
                    focus: {
                      path: focusInlineObject.path,
                      offset: 0,
                    },
                  },
                }),
              ],
            ],
          }),
          /**
           * When hitting SPACE, flip the state of all selected cells.
           */
          defineBehavior({
            on: 'keyboard.keydown',
            guard: ({snapshot, event}) => {
              if (event.originEvent.key !== ' ') {
                return false
              }

              const selectedValue = getSelectedValue(snapshot)

              const cellsSelected = selectedValue.flatMap((block) =>
                isTextBlock(snapshot.context, block)
                  ? block.children.flatMap((child) =>
                      isCellInlineObject(child)
                        ? {
                            node: child,
                            path: [
                              {_key: block._key},
                              'children',
                              {_key: child._key},
                            ] satisfies ChildPath,
                          }
                        : [],
                    )
                  : [],
              )

              return {
                cellsSelected,
              }
            },
            actions: [
              (_, {cellsSelected}) =>
                cellsSelected.map((cell) =>
                  raise({
                    type: 'child.set',
                    at: cell.path,
                    props: {
                      alive: !cell.node.alive,
                    },
                  }),
                ),
            ],
          }),
          /**
           * On every tick, calculate the new state of the cells.
           */
          defineBehavior({
            on: 'custom.tick',
            guard: ({snapshot}) => {
              // Extract cells from blocks into a 2D grid
              const grid: Array<
                Array<{path: ChildPath; node: CellInlineObject}>
              > = []

              for (const block of snapshot.context.value) {
                if (!isTextBlock(snapshot.context, block)) {
                  continue
                }

                const rowCells: Array<{
                  path: ChildPath
                  node: CellInlineObject
                }> = []

                for (const child of block.children) {
                  if (isCellInlineObject(child)) {
                    rowCells.push({
                      path: [
                        {_key: block._key},
                        'children',
                        {_key: child._key},
                      ] satisfies ChildPath,
                      node: child,
                    })
                  }
                }

                if (rowCells.length > 0) {
                  grid.push(rowCells)
                }
              }

              // Figure out which cells need updating, based on the Game of Life
              // rules.
              const actions: Array<BehaviorAction> = []

              for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
                for (
                  let cellIndex = 0;
                  cellIndex < grid[rowIndex].length;
                  cellIndex++
                ) {
                  const cell = grid[rowIndex][cellIndex]
                  const neighbors = countLiveNeighbors(
                    grid,
                    rowIndex,
                    cellIndex,
                  )

                  let newAlive = cell.node.alive

                  if (cell.node.alive) {
                    // Live cell with 2-3 neighbors survives
                    newAlive = neighbors === 2 || neighbors === 3
                  } else {
                    // Dead cell with exactly 3 neighbors becomes alive
                    newAlive = neighbors === 3
                  }

                  // Only add to updates if state changed
                  if (newAlive !== cell.node.alive) {
                    actions.push(
                      raise({
                        type: 'child.set',
                        at: cell.path,
                        props: {alive: newAlive},
                      }),
                    )
                  }
                }
              }

              return actions.length > 0 ? {actions} : false
            },
            actions: [(_, {actions}) => actions],
          }),
        ]}
      />
    </>
  )
}

function countLiveNeighbors(
  grid: Array<Array<{path: ChildPath; node: CellInlineObject}>>,
  row: number,
  col: number,
): number {
  let count = 0

  // Check all 8 neighbors
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      // Skip the cell itself
      if (i === 0 && j === 0) continue

      const newRow = row + i
      const newCol = col + j

      // Check bounds
      if (
        newRow >= 0 &&
        newRow < grid.length &&
        newCol >= 0 &&
        newCol < grid[newRow].length
      ) {
        if (grid[newRow][newCol].node.alive) {
          count++
        }
      }
    }
  }

  return count
}

const heartbeatMachine = setup({
  types: {
    context: {} as {
      editor: Editor
    },
    input: {} as {
      editor: Editor
    },
    events: {} as {type: 'tick'} | {type: 'stop'} | {type: 'start'},
  },
  actors: {
    tick: fromCallback(({sendBack}) => {
      const interval = setInterval(() => {
        sendBack({type: 'tick'})
      }, 1000)

      return () => {
        clearInterval(interval)
      }
    }),
  },
}).createMachine({
  id: 'heartbeat',
  context: ({input}) => ({
    editor: input.editor,
  }),
  initial: 'running',
  states: {
    paused: {
      on: {
        start: {
          target: 'running',
        },
      },
    },
    running: {
      invoke: {
        src: 'tick',
      },
      on: {
        tick: {
          actions: [
            ({context}) => {
              context.editor.send({type: 'custom.tick'})
            },
          ],
        },
        stop: {
          target: 'paused',
        },
      },
    },
  },
})
