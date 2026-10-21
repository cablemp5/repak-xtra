import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './OnboardingTour.css'

// repakxtra: the steps live in custom/tourSteps.ts (the essentials, each opening the view its target is in)
import { TOUR_STEPS, type Placement } from '../custom/tourSteps'

type TooltipPosition = {
    top: number
    left: number
    actualPlacement: Placement
    arrowOffset: number
}

type OnboardingTourProps = {
    isOpen: boolean
    onClose: () => void
}

const PADDING = 8
const TOOLTIP_GAP = 20
const VIEWPORT_MARGIN = 12

function getTargetRect(selector: string): DOMRect | null {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) return null
    return el.getBoundingClientRect()
}

function computeTooltipPosition(targetRect: DOMRect | null, placement: Placement, tooltipWidth: number, tooltipHeight: number): TooltipPosition {
    if (!targetRect) return { top: 0, left: 0, actualPlacement: placement, arrowOffset: 50 }

    const cutout = {
        top: targetRect.top - PADDING,
        left: targetRect.left - PADDING,
        width: targetRect.width + PADDING * 2,
        height: targetRect.height + PADDING * 2,
    }

    const targetCenterX = cutout.left + cutout.width / 2
    const targetCenterY = cutout.top + cutout.height / 2
    const vw = window.innerWidth
    const vh = window.innerHeight

    let top = 0
    let left = 0
    let actualPlacement = placement

    const calcPosition = (p: Placement): { top: number; left: number } => {
        switch (p) {
            case 'bottom':
                return { top: cutout.top + cutout.height + TOOLTIP_GAP, left: targetCenterX - tooltipWidth / 2 }
            case 'top':
                return { top: cutout.top - tooltipHeight - TOOLTIP_GAP, left: targetCenterX - tooltipWidth / 2 }
            case 'right':
                return { top: targetCenterY - tooltipHeight / 2, left: cutout.left + cutout.width + TOOLTIP_GAP }
            case 'left':
                return { top: targetCenterY - tooltipHeight / 2, left: cutout.left - tooltipWidth - TOOLTIP_GAP }
            default:
                return { top: cutout.top + cutout.height + TOOLTIP_GAP, left: targetCenterX - tooltipWidth / 2 }
        }
    }

    const fitsMainAxis = (p: Placement, pos: { top: number; left: number }): boolean => {
        switch (p) {
            case 'bottom': return pos.top + tooltipHeight <= vh - VIEWPORT_MARGIN
            case 'top': return pos.top >= VIEWPORT_MARGIN
            case 'right': return pos.left + tooltipWidth <= vw - VIEWPORT_MARGIN
            case 'left': return pos.left >= VIEWPORT_MARGIN
            default: return true
        }
    }

    let pos = calcPosition(placement)
    if (!fitsMainAxis(placement, pos)) {
        const allPlacements: Placement[] = ['bottom', 'top', 'right', 'left']
        const fallbacks = allPlacements.filter((p) => p !== placement)
        for (const fb of fallbacks) {
            const fbPos = calcPosition(fb)
            if (fitsMainAxis(fb, fbPos)) {
                pos = fbPos
                actualPlacement = fb
                break
            }
        }
    }

    top = pos.top
    left = pos.left

    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - tooltipWidth - VIEWPORT_MARGIN))
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - tooltipHeight - VIEWPORT_MARGIN))

    let arrowOffset = 50
    if (actualPlacement === 'bottom' || actualPlacement === 'top') {
        const arrowPx = targetCenterX - left
        arrowOffset = Math.max(10, Math.min(90, (arrowPx / tooltipWidth) * 100))
    } else {
        const arrowPx = targetCenterY - top
        arrowOffset = Math.max(10, Math.min(90, (arrowPx / tooltipHeight) * 100))
    }

    return { top, left, actualPlacement, arrowOffset }
}

function OnboardingTour({ isOpen, onClose }: OnboardingTourProps) {
    const [currentStep, setCurrentStep] = useState(0)
    const [targetRect, setTargetRect] = useState<DOMRect | null>(null)
    const [tooltipPos, setTooltipPos] = useState<TooltipPosition>({ top: 0, left: 0, actualPlacement: 'bottom', arrowOffset: 50 })
    const tooltipRef = useRef<HTMLDivElement | null>(null)

    const step = TOUR_STEPS[currentStep]

    const updatePositions = useCallback(() => {
        if (!isOpen || !step) return

        const rect = getTargetRect(step.target)
        setTargetRect(rect)

        if (rect && tooltipRef.current) {
            const tw = tooltipRef.current.offsetWidth
            const th = tooltipRef.current.offsetHeight
            const pos = computeTooltipPosition(rect, step.placement, tw, th)
            setTooltipPos(pos)
        } else if (tooltipRef.current) { // repakxtra: no target on screen: the tip sits centered
            setTooltipPos({ top: (window.innerHeight - tooltipRef.current.offsetHeight) / 2, left: (window.innerWidth - tooltipRef.current.offsetWidth) / 2, actualPlacement: step.placement, arrowOffset: -1 })
        }
    }, [isOpen, step])

    useEffect(() => {
        if (!isOpen) {
            setCurrentStep(0)
            return
        }

        step.onEnter?.() // repakxtra: show the view the target lives in
        const el = document.querySelector<HTMLElement>(step.target)
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }

        // repakxtra: the view switch slides in (250ms) and the scroll is smooth, so the target moves for a while after
        // this: follow it every frame until it settles, then on resize, scroll and its own size changes
        let frame = 0
        const until = performance.now() + 900
        const follow = () => { updatePositions(); if (performance.now() < until) frame = requestAnimationFrame(follow) }
        frame = requestAnimationFrame(follow)
        const ro = new ResizeObserver(() => updatePositions())
        if (el) ro.observe(el)
        window.addEventListener('scroll', updatePositions, true)

        return () => { cancelAnimationFrame(frame); ro.disconnect(); window.removeEventListener('scroll', updatePositions, true) }
    }, [isOpen, currentStep, step, updatePositions])

    useEffect(() => {
        if (!isOpen) return

        const handleResize = () => updatePositions()
        window.addEventListener('resize', handleResize)
        return () => window.removeEventListener('resize', handleResize)
    }, [isOpen, updatePositions])

    useEffect(() => {
        if (!isOpen) return

        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose()
            } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
                if (currentStep < TOUR_STEPS.length - 1) {
                    setCurrentStep(s => s + 1)
                } else {
                    onClose()
                }
            } else if (e.key === 'ArrowLeft') {
                if (currentStep > 0) setCurrentStep(s => s - 1)
            }
        }
        window.addEventListener('keydown', handleKey)
        return () => window.removeEventListener('keydown', handleKey)
    }, [isOpen, currentStep, onClose])

    if (!isOpen) return null

    const cutoutStyle = targetRect ? {
        top: targetRect.top - PADDING,
        left: targetRect.left - PADDING,
        width: targetRect.width + PADDING * 2,
        height: targetRect.height + PADDING * 2,
    } : null

    const isFirst = currentStep === 0
    const isLast = currentStep === TOUR_STEPS.length - 1

    return (
        <div className="onboarding-overlay">
            <AnimatePresence mode="wait">
                {cutoutStyle && (
                    <motion.div
                        key={`cutout-${currentStep}`}
                        className="onboarding-cutout"
                        initial={false}
                        animate={{
                            top: cutoutStyle.top,
                            left: cutoutStyle.left,
                            width: cutoutStyle.width,
                            height: cutoutStyle.height,
                        }}
                        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    />
                )}
            </AnimatePresence>

            <AnimatePresence mode="wait">
                <motion.div
                    key={`tooltip-${currentStep}`}
                    ref={tooltipRef}
                    className="onboarding-tooltip"
                    data-placement={tooltipPos.actualPlacement}
                    style={{
                        top: tooltipPos.top,
                        left: tooltipPos.left,
                    }}
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {tooltipPos.arrowOffset >= 0 && <div className="onboarding-tooltip-arrow" style={{ '--arrow-offset': `${tooltipPos.arrowOffset || 50}%` } as React.CSSProperties} />}

                    <div className="onboarding-tooltip-content">
                        <h3 className="onboarding-tooltip-title">{step.title}</h3>
                        <p className="onboarding-tooltip-desc">{step.description}</p>
                    </div>

                    <div className="onboarding-tooltip-footer">
                        <div className="onboarding-dots">
                            {TOUR_STEPS.map((_, i) => (
                                <button
                                    key={i}
                                    className={`onboarding-dot ${i === currentStep ? 'active' : ''}`}
                                    aria-label={`Step ${i + 1} of ${TOUR_STEPS.length}`} aria-current={i === currentStep ? 'step' : undefined} // repakxtra: the dots are the step count
                                    onClick={() => setCurrentStep(i)}
                                />
                            ))}
                        </div>

                        <div className="onboarding-actions">
                            <button className="onboarding-skip-btn" onClick={onClose} style={{ opacity: '0.7' }}>
                                Skip Tour
                            </button>
                            {!isFirst && (
                                <button
                                    className="onboarding-back-btn"
                                    onClick={() => setCurrentStep(s => s - 1)}
                                >
                                    Back
                                </button>
                            )}
                            <button
                                className="onboarding-next-btn"
                                onClick={() => {
                                    if (isLast) {
                                        onClose()
                                    } else {
                                        setCurrentStep(s => s + 1)
                                    }
                                }}
                            >
                                {isLast ? 'Finish' : 'Next'}
                            </button>
                        </div>
                    </div>
                </motion.div>
            </AnimatePresence>
        </div>
    )
}

export default OnboardingTour
