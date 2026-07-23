export interface ApiResponse<T = unknown> {
  [key: string]: unknown
  data?: T
  error?: string
  success?: boolean
}
