# Observation

状态：实测确认（受控 Mock）。New API Retry=1 且上游首次 503、第二次成功时，客户端只有 1 次 POST、上游有 2 次内容相同的 POST；两个上游 Request ID 不同。New API Retry 对客户端透明，并可能与未来客户端/ACU Retry 相乘。
