# 变量管理器
#
# 此文件记录所有需要追踪的关键变量及其管理规则。
# 导演和 skill 应据此文件判断：
#   - 哪些变量存在
#   - 变量在何时由哪个 skill 负责更新
#   - 变量的合法取值范围
#
# 格式说明：
#   每个变量一个条目，包含：
#   - name：变量名（与 active-vars.yaml 中的 key 对应）
#   - type：类型（number / string / boolean）
#   - initial：初始值
#   - update_trigger：何时更新（如"每楼层结束后"、"用户做出选择时"）
#   - responsible_skill：负责更新的 skill 名称
#   - note：补充说明
#
# 示例：
#
# - name: 金币
#   type: number
#   initial: 0
#   update_trigger: 每层结束后根据剧情增减
#   responsible_skill: teahouse-generate-floor
#   note: 不可为负
#
# - name: 主线进度
#   type: string
#   initial: 序章
#   update_trigger: 关键剧情节点
#   responsible_skill: teahouse-generate-floor
#   note: 可选值：序章 / 第一章 / 第二章 / ...
