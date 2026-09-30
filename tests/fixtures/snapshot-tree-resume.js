/* @playwright/cli 0.1.21 实采：简历筛选页 snapshot --json 的结构化无障碍树
 * （node 键：role/name/text/ref/children/cursor/level/active/selected/disabled） */
module.exports = [
  {
    "role": "generic",
    "active": true,
    "ref": "e1",
    "children": [
      {
        "role": "banner",
        "ref": "e2",
        "children": [
          {
            "role": "generic",
            "ref": "e3",
            "text": "◇ 星河招聘中台"
          },
          {
            "role": "generic",
            "ref": "e4",
            "text": "搜索姓名 / 手机号"
          },
          {
            "role": "searchbox",
            "name": "搜索姓名 / 手机号",
            "ref": "e5"
          },
          {
            "role": "button",
            "name": "重置演示",
            "ref": "e6",
            "cursor": "pointer"
          }
        ]
      },
      {
        "role": "generic",
        "ref": "e7",
        "children": [
          {
            "role": "navigation",
            "name": "处理状态快捷筛选",
            "ref": "e8",
            "children": [
              {
                "role": "list",
                "ref": "e9",
                "children": [
                  {
                    "role": "listitem",
                    "ref": "e10",
                    "children": [
                      {
                        "role": "button",
                        "name": "全部候选人 (16)",
                        "ref": "e11",
                        "cursor": "pointer",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e12",
                            "text": "全部候选人"
                          },
                          {
                            "role": "generic",
                            "ref": "e13",
                            "text": "(16)"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "listitem",
                    "ref": "e14",
                    "children": [
                      {
                        "role": "button",
                        "name": "待处理 (16)",
                        "ref": "e15",
                        "cursor": "pointer",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e16",
                            "text": "待处理"
                          },
                          {
                            "role": "generic",
                            "ref": "e17",
                            "text": "(16)"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "listitem",
                    "ref": "e18",
                    "children": [
                      {
                        "role": "button",
                        "name": "已邀请面试 (0)",
                        "ref": "e19",
                        "cursor": "pointer",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e20",
                            "text": "已邀请面试"
                          },
                          {
                            "role": "generic",
                            "ref": "e21",
                            "text": "(0)"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "listitem",
                    "ref": "e22",
                    "children": [
                      {
                        "role": "button",
                        "name": "已标记不合适 (0)",
                        "ref": "e23",
                        "cursor": "pointer",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e24",
                            "text": "已标记不合适"
                          },
                          {
                            "role": "generic",
                            "ref": "e25",
                            "text": "(0)"
                          }
                        ]
                      }
                    ]
                  }
                ]
              },
              {
                "role": "paragraph",
                "ref": "e26",
                "text": "已邀请 0 位已标记不合适 0 位"
              },
              {
                "role": "paragraph",
                "ref": "e27",
                "text": "最近邀请：暂无"
              }
            ]
          },
          {
            "role": "main",
            "ref": "e28",
            "children": [
              {
                "role": "generic",
                "ref": "e29",
                "children": [
                  {
                    "role": "heading",
                    "name": "候选人管理",
                    "level": 1,
                    "ref": "e30"
                  },
                  {
                    "role": "generic",
                    "ref": "e31",
                    "text": "共 16 位 · 待处理 16 位 · 已邀请 0 位"
                  }
                ]
              },
              {
                "role": "generic",
                "ref": "e32",
                "children": [
                  {
                    "role": "generic",
                    "ref": "e33",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e34",
                        "text": "投递岗位"
                      },
                      {
                        "role": "combobox",
                        "name": "投递岗位",
                        "ref": "e35",
                        "children": [
                          {
                            "role": "option",
                            "name": "全部岗位",
                            "selected": true
                          },
                          {
                            "role": "option",
                            "name": "高级前端工程师"
                          },
                          {
                            "role": "option",
                            "name": "前端工程师"
                          },
                          {
                            "role": "option",
                            "name": "测试工程师"
                          },
                          {
                            "role": "option",
                            "name": "Java 后端工程师"
                          },
                          {
                            "role": "option",
                            "name": "UI 设计师"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "generic",
                    "ref": "e36",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e37",
                        "text": "处理状态"
                      },
                      {
                        "role": "combobox",
                        "name": "处理状态",
                        "ref": "e38",
                        "children": [
                          {
                            "role": "option",
                            "name": "全部",
                            "selected": true
                          },
                          {
                            "role": "option",
                            "name": "待处理"
                          },
                          {
                            "role": "option",
                            "name": "已邀请面试"
                          },
                          {
                            "role": "option",
                            "name": "已标记不合适"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "button",
                    "name": "查询",
                    "ref": "e39",
                    "cursor": "pointer"
                  },
                  {
                    "role": "button",
                    "name": "重置",
                    "ref": "e40",
                    "cursor": "pointer"
                  }
                ]
              },
              {
                "role": "generic",
                "ref": "e41",
                "children": [
                  {
                    "role": "article",
                    "name": "候选人 李强（高级前端工程师）",
                    "ref": "e42",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e43",
                        "children": [
                          {
                            "role": "button",
                            "name": "李强",
                            "ref": "e44",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e45",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e46",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e47",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e48",
                            "text": "期望 38K"
                          },
                          {
                            "role": "generic",
                            "ref": "e49",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e50",
                            "text": "工作年限 7 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e51",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e52",
                            "text": "更新于 2026-09-22"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e53",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e54",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e55",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e56",
                            "text": "Webpack"
                          },
                          {
                            "role": "generic",
                            "ref": "e57",
                            "text": "Jest"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e58",
                        "text": "最近一份工作：远山电商 高级前端（2019.06 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e59",
                        "text": "138****2210"
                      },
                      {
                        "role": "generic",
                        "ref": "e60",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e61",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e62",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e63",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 李强（前端工程师）",
                    "ref": "e64",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e65",
                        "children": [
                          {
                            "role": "button",
                            "name": "李强",
                            "ref": "e66",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e67",
                            "text": "前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e68",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e69",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e70",
                            "text": "期望 28K"
                          },
                          {
                            "role": "generic",
                            "ref": "e71",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e72",
                            "text": "工作年限 4 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e73",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e74",
                            "text": "更新于 2026-09-21"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e75",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e76",
                            "text": "Vue"
                          },
                          {
                            "role": "generic",
                            "ref": "e77",
                            "text": "JavaScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e78",
                            "text": "Vite"
                          },
                          {
                            "role": "generic",
                            "ref": "e79",
                            "text": "ECharts"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e80",
                        "text": "最近一份工作：蓝湾信息 前端（2022.03 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e81",
                        "text": "139****7742"
                      },
                      {
                        "role": "generic",
                        "ref": "e82",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e83",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e84",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e85",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 张雨薇（高级前端工程师）",
                    "ref": "e86",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e87",
                        "children": [
                          {
                            "role": "button",
                            "name": "张雨薇",
                            "ref": "e88",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e89",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e90",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e91",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e92",
                            "text": "期望 45K"
                          },
                          {
                            "role": "generic",
                            "ref": "e93",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e94",
                            "text": "工作年限 8 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e95",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e96",
                            "text": "更新于 2026-09-22"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e97",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e98",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e99",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e100",
                            "text": "Node.js"
                          },
                          {
                            "role": "generic",
                            "ref": "e101",
                            "text": "微前端"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e102",
                        "text": "最近一份工作：启明星云 高级前端（2018.07 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e103",
                        "text": "137****3156"
                      },
                      {
                        "role": "generic",
                        "ref": "e104",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e105",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e106",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e107",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 刘畅（前端工程师）",
                    "ref": "e108",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e109",
                        "children": [
                          {
                            "role": "button",
                            "name": "刘畅",
                            "ref": "e110",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e111",
                            "text": "前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e112",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e113",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e114",
                            "text": "期望 30K"
                          },
                          {
                            "role": "generic",
                            "ref": "e115",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e116",
                            "text": "工作年限 3 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e117",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e118",
                            "text": "更新于 2026-09-20"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e119",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e120",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e121",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e122",
                            "text": "React Query"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e123",
                        "text": "最近一份工作：橘子互娱 前端（2023.04 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e124",
                        "text": "136****8820"
                      },
                      {
                        "role": "generic",
                        "ref": "e125",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e126",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e127",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e128",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 陈默（高级前端工程师）",
                    "ref": "e129",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e130",
                        "children": [
                          {
                            "role": "button",
                            "name": "陈默",
                            "ref": "e131",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e132",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e133",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e134",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e135",
                            "text": "期望 33K"
                          },
                          {
                            "role": "generic",
                            "ref": "e136",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e137",
                            "text": "工作年限 6 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e138",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e139",
                            "text": "更新于 2026-09-22"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e140",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e141",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e142",
                            "text": "Redux"
                          },
                          {
                            "role": "generic",
                            "ref": "e143",
                            "text": "Webpack"
                          },
                          {
                            "role": "generic",
                            "ref": "e144",
                            "text": "Node.js"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e145",
                        "text": "最近一份工作：北岭科技 高级前端（2020.01 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e146",
                        "text": "135****4491"
                      },
                      {
                        "role": "generic",
                        "ref": "e147",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e148",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e149",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e150",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 周一鸣（高级前端工程师）",
                    "ref": "e151",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e152",
                        "children": [
                          {
                            "role": "button",
                            "name": "周一鸣",
                            "ref": "e153",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e154",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e155",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e156",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e157",
                            "text": "期望 32K"
                          },
                          {
                            "role": "generic",
                            "ref": "e158",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e159",
                            "text": "工作年限 6 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e160",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e161",
                            "text": "更新于 2026-09-23"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e162",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e163",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e164",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e165",
                            "text": "Node.js"
                          },
                          {
                            "role": "generic",
                            "ref": "e166",
                            "text": "Vite"
                          },
                          {
                            "role": "generic",
                            "ref": "e167",
                            "text": "CI/CD"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e168",
                        "text": "最近一份工作：星图数据 高级前端（2020.09 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e169",
                        "text": "188****6027"
                      },
                      {
                        "role": "generic",
                        "ref": "e170",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e171",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e172",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e173",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 吴佳宁（测试工程师）",
                    "ref": "e174",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e175",
                        "children": [
                          {
                            "role": "button",
                            "name": "吴佳宁",
                            "ref": "e176",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e177",
                            "text": "测试工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e178",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e179",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e180",
                            "text": "期望 25K"
                          },
                          {
                            "role": "generic",
                            "ref": "e181",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e182",
                            "text": "工作年限 5 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e183",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e184",
                            "text": "更新于 2026-09-19"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e185",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e186",
                            "text": "Selenium"
                          },
                          {
                            "role": "generic",
                            "ref": "e187",
                            "text": "Postman"
                          },
                          {
                            "role": "generic",
                            "ref": "e188",
                            "text": "JMeter"
                          },
                          {
                            "role": "generic",
                            "ref": "e189",
                            "text": "禅道"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e190",
                        "text": "最近一份工作：白云山健康 测试（2021.05 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e191",
                        "text": "186****1358"
                      },
                      {
                        "role": "generic",
                        "ref": "e192",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e193",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e194",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e195",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 郑飞（高级前端工程师）",
                    "ref": "e196",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e197",
                        "children": [
                          {
                            "role": "button",
                            "name": "郑飞",
                            "ref": "e198",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e199",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e200",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e201",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e202",
                            "text": "期望 36K"
                          },
                          {
                            "role": "generic",
                            "ref": "e203",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e204",
                            "text": "工作年限 9 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e205",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e206",
                            "text": "更新于 2026-09-21"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e207",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e208",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e209",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e210",
                            "text": "qiankun 微前端"
                          },
                          {
                            "role": "generic",
                            "ref": "e211",
                            "text": "前端监控"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e212",
                        "text": "最近一份工作：大河金服 资深前端（2017.03 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e213",
                        "text": "159****7734"
                      },
                      {
                        "role": "generic",
                        "ref": "e214",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e215",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e216",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e217",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 王思颖（前端工程师）",
                    "ref": "e218",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e219",
                        "children": [
                          {
                            "role": "button",
                            "name": "王思颖",
                            "ref": "e220",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e221",
                            "text": "前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e222",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e223",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e224",
                            "text": "期望 26K"
                          },
                          {
                            "role": "generic",
                            "ref": "e225",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e226",
                            "text": "工作年限 2 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e227",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e228",
                            "text": "更新于 2026-09-20"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e229",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e230",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e231",
                            "text": "JavaScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e232",
                            "text": "微信小程序"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e233",
                        "text": "最近一份工作：拾光文创 前端（2024.02 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e234",
                        "text": "158****2261"
                      },
                      {
                        "role": "generic",
                        "ref": "e235",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e236",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e237",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e238",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 冯超（Java 后端工程师）",
                    "ref": "e239",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e240",
                        "children": [
                          {
                            "role": "button",
                            "name": "冯超",
                            "ref": "e241",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e242",
                            "text": "Java 后端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e243",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e244",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e245",
                            "text": "期望 30K"
                          },
                          {
                            "role": "generic",
                            "ref": "e246",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e247",
                            "text": "工作年限 6 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e248",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e249",
                            "text": "更新于 2026-09-18"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e250",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e251",
                            "text": "Java"
                          },
                          {
                            "role": "generic",
                            "ref": "e252",
                            "text": "Spring Cloud"
                          },
                          {
                            "role": "generic",
                            "ref": "e253",
                            "text": "MySQL"
                          },
                          {
                            "role": "generic",
                            "ref": "e254",
                            "text": "Redis"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e255",
                        "text": "最近一份工作：万川物流 后端（2019.11 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e256",
                        "text": "150****9905"
                      },
                      {
                        "role": "generic",
                        "ref": "e257",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e258",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e259",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e260",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 徐蕾（高级前端工程师）",
                    "ref": "e261",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e262",
                        "children": [
                          {
                            "role": "button",
                            "name": "徐蕾",
                            "ref": "e263",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e264",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e265",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e266",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e267",
                            "text": "期望 36K"
                          },
                          {
                            "role": "generic",
                            "ref": "e268",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e269",
                            "text": "工作年限 5 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e270",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e271",
                            "text": "更新于 2026-09-22"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e272",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e273",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e274",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e275",
                            "text": "AntV 数据可视化"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e276",
                        "text": "最近一份工作：晨曦医疗 高级前端（2021.02 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e277",
                        "text": "151****4473"
                      },
                      {
                        "role": "generic",
                        "ref": "e278",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e279",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e280",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e281",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 高翔（测试开发工程师）",
                    "ref": "e282",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e283",
                        "children": [
                          {
                            "role": "button",
                            "name": "高翔",
                            "ref": "e284",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e285",
                            "text": "测试开发工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e286",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e287",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e288",
                            "text": "期望 28K"
                          },
                          {
                            "role": "generic",
                            "ref": "e289",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e290",
                            "text": "工作年限 4 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e291",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e292",
                            "text": "更新于 2026-09-17"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e293",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e294",
                            "text": "Python"
                          },
                          {
                            "role": "generic",
                            "ref": "e295",
                            "text": "Pytest"
                          },
                          {
                            "role": "generic",
                            "ref": "e296",
                            "text": "Allure"
                          },
                          {
                            "role": "generic",
                            "ref": "e297",
                            "text": "Jenkins"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e298",
                        "text": "最近一份工作：远航出行 测试开发（2022.08 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e299",
                        "text": "152****6688"
                      },
                      {
                        "role": "generic",
                        "ref": "e300",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e301",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e302",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e303",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 罗静（前端工程师）",
                    "ref": "e304",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e305",
                        "children": [
                          {
                            "role": "button",
                            "name": "罗静",
                            "ref": "e306",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e307",
                            "text": "前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e308",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e309",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e310",
                            "text": "期望 27K"
                          },
                          {
                            "role": "generic",
                            "ref": "e311",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e312",
                            "text": "工作年限 3 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e313",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e314",
                            "text": "更新于 2026-09-19"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e315",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e316",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e317",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e318",
                            "text": "微信小程序"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e319",
                        "text": "最近一份工作：竹间教育 前端（2023.06 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e320",
                        "text": "153****3102"
                      },
                      {
                        "role": "generic",
                        "ref": "e321",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e322",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e323",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e324",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 黄志远（高级前端工程师）",
                    "ref": "e325",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e326",
                        "children": [
                          {
                            "role": "button",
                            "name": "黄志远",
                            "ref": "e327",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e328",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e329",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e330",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e331",
                            "text": "期望 33K"
                          },
                          {
                            "role": "generic",
                            "ref": "e332",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e333",
                            "text": "工作年限 6 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e334",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e335",
                            "text": "更新于 2026-09-21"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e336",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e337",
                            "text": "Vue"
                          },
                          {
                            "role": "generic",
                            "ref": "e338",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e339",
                            "text": "Vite"
                          },
                          {
                            "role": "generic",
                            "ref": "e340",
                            "text": "Pinia"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e341",
                        "text": "最近一份工作：南山智驾 高级前端（2019.04 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e342",
                        "text": "155****8845"
                      },
                      {
                        "role": "generic",
                        "ref": "e343",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e344",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e345",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e346",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 宋雨桐（UI 设计师）",
                    "ref": "e347",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e348",
                        "children": [
                          {
                            "role": "button",
                            "name": "宋雨桐",
                            "ref": "e349",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e350",
                            "text": "UI 设计师"
                          },
                          {
                            "role": "generic",
                            "ref": "e351",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e352",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e353",
                            "text": "期望 20K"
                          },
                          {
                            "role": "generic",
                            "ref": "e354",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e355",
                            "text": "工作年限 3 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e356",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e357",
                            "text": "更新于 2026-09-16"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e358",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e359",
                            "text": "Figma"
                          },
                          {
                            "role": "generic",
                            "ref": "e360",
                            "text": "Sketch"
                          },
                          {
                            "role": "generic",
                            "ref": "e361",
                            "text": "C4D"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e362",
                        "text": "最近一份工作：光合工作室 UI 设计（2023.01 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e363",
                        "text": "156****2276"
                      },
                      {
                        "role": "generic",
                        "ref": "e364",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e365",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e366",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e367",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  },
                  {
                    "role": "article",
                    "name": "候选人 马奔腾（高级前端工程师）",
                    "ref": "e368",
                    "children": [
                      {
                        "role": "generic",
                        "ref": "e369",
                        "children": [
                          {
                            "role": "button",
                            "name": "马奔腾",
                            "ref": "e370",
                            "cursor": "pointer"
                          },
                          {
                            "role": "generic",
                            "ref": "e371",
                            "text": "高级前端工程师"
                          },
                          {
                            "role": "generic",
                            "ref": "e372",
                            "text": "待处理"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e373",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e374",
                            "text": "期望 40K"
                          },
                          {
                            "role": "generic",
                            "ref": "e375",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e376",
                            "text": "工作年限 10 年"
                          },
                          {
                            "role": "generic",
                            "ref": "e377",
                            "text": "·"
                          },
                          {
                            "role": "generic",
                            "ref": "e378",
                            "text": "更新于 2026-09-22"
                          }
                        ]
                      },
                      {
                        "role": "generic",
                        "ref": "e379",
                        "children": [
                          {
                            "role": "generic",
                            "ref": "e380",
                            "text": "React"
                          },
                          {
                            "role": "generic",
                            "ref": "e381",
                            "text": "TypeScript"
                          },
                          {
                            "role": "generic",
                            "ref": "e382",
                            "text": "GraphQL"
                          },
                          {
                            "role": "generic",
                            "ref": "e383",
                            "text": "性能优化"
                          }
                        ]
                      },
                      {
                        "role": "paragraph",
                        "ref": "e384",
                        "text": "最近一份工作：九天智算 资深前端（2016.05 至今）"
                      },
                      {
                        "role": "paragraph",
                        "ref": "e385",
                        "text": "157****9931"
                      },
                      {
                        "role": "generic",
                        "ref": "e386",
                        "children": [
                          {
                            "role": "button",
                            "name": "查看简历",
                            "ref": "e387",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "邀请面试",
                            "ref": "e388",
                            "cursor": "pointer"
                          },
                          {
                            "role": "button",
                            "name": "标记不合适",
                            "ref": "e389",
                            "cursor": "pointer"
                          }
                        ]
                      }
                    ]
                  }
                ]
              },
              {
                "role": "navigation",
                "name": "分页",
                "ref": "e390",
                "children": [
                  {
                    "role": "button",
                    "name": "上一页",
                    "disabled": true,
                    "ref": "e391"
                  },
                  {
                    "role": "generic",
                    "ref": "e392",
                    "text": "第 1 / 2 页 · 共 27 位候选人"
                  },
                  {
                    "role": "button",
                    "name": "下一页",
                    "ref": "e393",
                    "cursor": "pointer"
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        "role": "status"
      }
    ]
  }
];
