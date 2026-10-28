import { useState, useEffect, useRef } from 'react'
import './NumberInput.css'

type NumberInputProps = {
  value: number
  min?: number
  max?: number
  onChange?: (value: number) => void
  className?: string
  disabled?: boolean
}

const NumberInput = ({ value, min = 0, max = 999, onChange, className, disabled }: NumberInputProps) => {
  const [localValue, setLocalValue] = useState<number | ''>(value)
  const [isOnCooldown, setIsOnCooldown] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current)
      }
    }
  }, [])

  const commitValue = (newValue: number | '') => {
    if (disabled) return
    // If empty string or NaN, revert to original value
    if (newValue === '' || isNaN(newValue)) {
      setLocalValue(value)
      return
    }

    let clamped = Math.max(min, Math.min(max, newValue))

    setLocalValue(clamped)
    if (onChange && clamped !== value) {
      onChange(clamped)
    }
  }

  const handleBlur = () => {
    commitValue(localValue)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      inputRef.current?.blur()
    }
  }

  const triggerCooldown = () => {
    setIsOnCooldown(true)
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current)
    }
    cooldownTimerRef.current = setTimeout(() => {
      setIsOnCooldown(false)
    }, 2000)
  }

  const handleIncrement = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (disabled || isOnCooldown) return

    const current = typeof localValue === 'number' ? localValue : value
    const newValue = Math.min(max, current + 1)
    setLocalValue(newValue)
    if (onChange && newValue !== value) {
      onChange(newValue)
      triggerCooldown()
    }
  }

  const handleDecrement = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (disabled || isOnCooldown) return

    const current = typeof localValue === 'number' ? localValue : value
    const newValue = Math.max(min, current - 1)
    setLocalValue(newValue)
    if (onChange && newValue !== value) {
      onChange(newValue)
      triggerCooldown()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return
    const inputValue = e.target.value
    if (inputValue === '') {
      setLocalValue('')
      return
    }
    const val = parseInt(inputValue, 10)
    setLocalValue(isNaN(val) ? '' : val)
  }

  const numericLocalValue = typeof localValue === 'number' ? localValue : value

  return (
    <div className={`number-input-container ${className || ''} ${disabled ? 'disabled' : ''}`} onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
      <button
        type="button"
        className="number-btn minus"
        aria-label="Lower" // repakxtra: named for screen readers (the stepper's own label says what it counts)
        onClick={handleDecrement}
        disabled={disabled || numericLocalValue <= min || isOnCooldown}
      >
        −
      </button>
      <input
        ref={inputRef}
        type="number"
        className="number-display"
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        min={min}
        max={max}
        disabled={disabled}
      />
      <button
        type="button"
        className="number-btn plus"
        aria-label="Raise" // repakxtra
        onClick={handleIncrement}
        disabled={disabled || numericLocalValue >= max || isOnCooldown}
      >
        +
      </button>
    </div>
  )
}

export default NumberInput
